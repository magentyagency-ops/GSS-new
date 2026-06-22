import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import PizZip from 'pizzip';
import OpenAI from 'openai';
import { getSettings } from '../core/config';
import { DB } from '../core/db';
import { extractText } from '../ingestion/docConverter';
import { overlaySynthesis, loadTrebuchetFont, measureZonesCapacity, RefReplacement, RefContext } from './pdf_overlay';
// @ts-ignore
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// Modèle utilisé pour la génération. gpt-4o-mini a une limite TPM bien plus élevée (200k vs 30k
// pour gpt-4o sur ce compte) → génération rapide sans throttling. Surchargeable par env.
const MEMOIRE_MODEL = process.env.MEMOIRE_MODEL || 'gpt-4o-mini';

// Modèle de génération d'IMAGES pour remplir les cadres « Zone d'image » du template.
// Désactivable via GENERATE_IMAGES=false (étape coûteuse, non bloquante).
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-1';
const IMAGES_ENABLED = process.env.GENERATE_IMAGES !== 'false';

// Modèle d'EMBEDDINGS pour la recherche sémantique (index Doc GSS + DCE). text-embedding-3-small :
// 1536 dim, peu coûteux, TPM élevée → on peut indexer toute la doc + embedder chaque requête de champ.
const EMBED_MODEL = process.env.EMBEDDING_MODEL_MEMOIRE || 'text-embedding-3-small';

/** Un passage indexable pour la recherche sémantique (Doc GSS ou DCE). */
interface RetrievalChunk { source: 'GSS' | 'DCE'; label: string; text: string; embedding?: number[]; }

/** Similarité cosinus entre deux vecteurs (0 si l'un est nul). */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ─── DOM Helpers ───

function findLocalNameChild(node: any, name: string): any {
  if (!node.childNodes) return null;
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 1 && child.localName === name) return child;
  }
  return null;
}

function getElementsWithLocalName(node: any, name: string): any[] {
  const results: any[] = [];
  const walk = (n: any) => {
    if (n.nodeType === 1 && n.localName === name) results.push(n);
    if (n.childNodes) {
      for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]);
    }
  };
  walk(node);
  return results;
}

function getParentWithLocalName(node: any, name: string): any {
  let parent = node.parentNode;
  while (parent) {
    if (parent.nodeType === 1 && parent.localName === name) return parent;
    parent = parent.parentNode;
  }
  return null;
}

function getDirectCells(tr: any): any[] {
  const cells: any[] = [];
  const walk = (node: any) => {
    if (node.nodeType === 1) {
      if (node.localName === 'tc') { cells.push(node); return; }
      if (node.localName === 'tbl' || node.localName === 'tr') return;
    }
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
  };
  if (tr.childNodes) {
    for (let i = 0; i < tr.childNodes.length; i++) walk(tr.childNodes[i]);
  }
  return cells;
}

function getElementText(node: any): string {
  let text = '';
  const walk = (n: any) => {
    if (n.nodeType === 1 && n.localName === 't') text += n.textContent || '';
    if (n.childNodes) {
      for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]);
    }
  };
  walk(node);
  return text;
}

function isHeadingParagraph(p: any): boolean {
  const text = getElementText(p).trim();
  if (!text || text.length > 120) return false;
  const pPr = findLocalNameChild(p, 'pPr');
  if (pPr) {
    const pStyle = findLocalNameChild(pPr, 'pStyle');
    if (pStyle) {
      const val = pStyle.getAttribute('w:val') || '';
      if (/heading|titre|title/i.test(val)) return true;
    }
  }
  if (/^(?:[I|V|X|L|C]+\.|[0-9]+(?:\.[0-9]+)*\.?|[A-Z]\.)\s+[A-ZÀ-ÿ]/i.test(text)) return true;
  if (text.length > 5 && text === text.toUpperCase() && /[A-Z]/.test(text)) return true;
  return false;
}

function getTableCellContext(cell: any, tr: any): string {
  const directCells = getDirectCells(tr);
  const cellIndex = directCells.indexOf(cell);
  const rowContext = directCells.filter((c: any) => c !== cell).map((c: any) => getElementText(c).trim()).filter(Boolean).join(' | ');
  const tbl = getParentWithLocalName(tr, 'tbl');
  if (tbl) {
    const allRows = getElementsWithLocalName(tbl, 'tr');
    if (allRows.length > 0) {
      const headerCells = getDirectCells(allRows[0]);
      if (headerCells.length > 0 && allRows[0] !== tr) {
        let headerText = '';
        if (cellIndex >= 0 && cellIndex < headerCells.length) {
          headerText = getElementText(headerCells[cellIndex]).trim();
        }
        if (headerText) return `Colonne: "${headerText}" | Ligne: "${rowContext}"`;
      }
    }
  }
  return `Ligne: "${rowContext}"`;
}

function replaceTextInElement(xmlDoc: any, tEl: any, placeholder: string, value: string) {
  const text = tEl.textContent || '';
  if (!text.includes(placeholder)) return;
  if (!value.includes('\n')) {
    tEl.textContent = text.replace(placeholder, value);
    return;
  }
  const parentRun = tEl.parentNode;
  if (!parentRun || parentRun.localName !== 'r') {
    tEl.textContent = text.replace(placeholder, value.replace(/\r?\n/g, ' '));
    return;
  }
  const parts = text.split(placeholder);
  if (parts.length < 2) return;
  tEl.textContent = '';
  const elementsToInsert: any[] = [];
  if (parts[0]) {
    const tBefore = xmlDoc.createElementNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w:t');
    tBefore.setAttribute('xml:space', 'preserve');
    tBefore.textContent = parts[0];
    elementsToInsert.push(tBefore);
  }
  const lines = value.split(/\r?\n/);
  lines.forEach((line: string, index: number) => {
    if (index > 0) {
      const br = xmlDoc.createElementNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w:br');
      elementsToInsert.push(br);
    }
    const tLine = xmlDoc.createElementNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w:t');
    tLine.setAttribute('xml:space', 'preserve');
    tLine.textContent = line;
    elementsToInsert.push(tLine);
  });
  if (parts[1]) {
    const tAfter = xmlDoc.createElementNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w:t');
    tAfter.setAttribute('xml:space', 'preserve');
    tAfter.textContent = parts[1];
    elementsToInsert.push(tAfter);
  }
  elementsToInsert.forEach((el: any) => parentRun.insertBefore(el, tEl));
  parentRun.removeChild(tEl);
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function getParagraphStyle(p: any): string {
  const pPr = findLocalNameChild(p, 'pPr');
  if (!pPr) return '';
  const pStyle = findLocalNameChild(pPr, 'pStyle');
  return pStyle ? (pStyle.getAttribute('w:val') || '') : '';
}

// ─── Préservation du maître AO RNE : duplication de "spreads" (pages conçues) ───
// On NE reconstruit plus le document : on garde AO RNE.docx INTACT (design + 221
// images) et on AJOUTE des pages en DUPLIQUANT des pages existantes. Une page conçue
// ("spread") = une section image+titre (image plein-cadre behindDoc + zone de texte
// de titre) SUIVIE d'une section de corps de texte (paragraphes 2 colonnes). Cloner
// ces sections telles quelles préserve le format/design ; il suffit ensuite de
// renuméroter les ids de dessin (wp:docPr / pic:cNvPr — uniques, sinon Word "répare")
// et de remplacer le titre + le corps par le texte personnalisé.

/** Découpe le corps en sections OOXML : une section = paragraphes consécutifs jusqu'au
 * (et incluant le) paragraphe portant <w:sectPr>. Le sectPr final est au niveau body. */
function splitBodyIntoSections(body: any): { sections: any[][]; finalSectPr: any | null } {
  const sections: any[][] = [];
  let cur: any[] = [];
  let finalSectPr: any = null;
  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes[i];
    if (node.nodeType !== 1) continue;
    if (node.localName === 'p') {
      cur.push(node);
      const pPr = findLocalNameChild(node, 'pPr');
      if (pPr && findLocalNameChild(pPr, 'sectPr')) { sections.push(cur); cur = []; }
    } else if (node.localName === 'sectPr') {
      finalSectPr = node;
    }
  }
  if (cur.length) sections.push(cur);
  return { sections, finalSectPr };
}

const sectionHasBackgroundImage = (paras: any[]): boolean =>
  paras.some(p => getElementsWithLocalName(p, 'anchor').some((a: any) => a.getAttribute('behindDoc') === '1'));
const sectionHasTextbox = (paras: any[]): boolean =>
  paras.some(p => getElementsWithLocalName(p, 'txbxContent').length > 0);
const sectionIsPlainText = (paras: any[]): boolean =>
  !paras.some(p => getElementsWithLocalName(p, 'drawing').length > 0 || getElementsWithLocalName(p, 'pict').length > 0);

/** Couleur de l'aplat gris clair pleine page du template (corps des pages). */
const GREY_BG_HEX = 'D9D9D9';

/**
 * Trouve le run contenant le rectangle gris clair (#D9D9D9) pleine page utilisé comme
 * fond sur les pages de corps du template AO RNE. C'est un shape vectoriel (solidFill,
 * SANS image) ancré en behindDoc="1", de taille ~21cm × 29.7cm, positionné à page
 * offset (0,0). Attention : le template contient aussi 6 rectangles gris FONCÉ (#494545)
 * pleine page — on les écarte en exigeant explicitement la couleur #D9D9D9. On saute
 * également les premiers paragraphes pour ignorer la couverture. Renvoie le run à cloner.
 */
function findFullPageBackgroundRun(body: any): any | null {
  if (!body || !body.childNodes) return null;
  // On saute les premiers paragraphes (couverture / sommaire) pour cibler les pages de corps
  const MIN_PARA = 50;  // les pages de corps commencent bien après la couverture
  let paraCount = 0;
  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes[i];
    if (node.nodeType !== 1 || node.localName !== 'p') continue;
    paraCount++;
    if (paraCount < MIN_PARA) continue;

    const runs = getElementsWithLocalName(node, 'r');
    for (const r of runs) {
      // On ne veut PAS d'image : uniquement l'aplat gris vectoriel
      if (getElementsWithLocalName(r, 'blip').length > 0) continue;
      const anchors = getElementsWithLocalName(r, 'anchor');
      for (const a of anchors) {
        if (a.getAttribute('behindDoc') !== '1') continue;
        const extent = findLocalNameChild(a, 'extent');
        if (!extent) continue;
        const cx = parseInt(extent.getAttribute('cx') || '0', 10);
        const cy = parseInt(extent.getAttribute('cy') || '0', 10);
        const wCm = cx / 914400 * 2.54;
        const hCm = cy / 914400 * 2.54;
        // Pleine page A4 : >19cm large, >28cm haut
        if (wCm < 19 || hCm < 28) continue;
        // Exiger la couleur gris clair #D9D9D9 (pas le gris foncé #494545)
        const colors = getElementsWithLocalName(a, 'srgbClr')
          .map((c: any) => (c.getAttribute('val') || '').toUpperCase());
        if (colors.includes(GREY_BG_HEX)) return r;
      }
    }
  }
  return null;
}

/**
 * Injecte un clone du rectangle gris clair pleine page dans le premier paragraphe d'un
 * ensemble de paragraphes (section corps d'un spread cloné). Les IDs de dessin sont
 * renumérotés pour éviter les doublons Word.
 */
function injectFullPageBackground(bodyParas: any[], bgRun: any, counter: { v: number }) {
  if (!bgRun || bodyParas.length === 0) return;
  const clone = bgRun.cloneNode(true);
  renumberDrawingIds(clone, counter);
  const firstPara = bodyParas[0];
  firstPara.insertBefore(clone, firstPara.firstChild);
}

/**
 * Trouve le run contenant le bandeau « GSS » (logo œil + GSS, image5.png) qui coiffe
 * le titre de chaque page de corps du template. C'est un groupe autonome (sans texte ni
 * zone de titre) ancré en behindDoc="1", de largeur pleine page (~21cm) mais PEU haut
 * (~3.3cm). On le distingue du fond pleine page (haut) par sa faible hauteur, et des
 * blocs de titre par l'absence de texte. Renvoie le run DOM à cloner, ou null.
 */
function findGssBannerRun(body: any): any | null {
  if (!body || !body.childNodes) return null;
  const MIN_PARA = 50;        // on saute la couverture / le sommaire
  const MAX_H_CM = 6;         // bandeau de titre : court (≠ fond pleine page)
  let paraCount = 0;
  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes[i];
    if (node.nodeType !== 1 || node.localName !== 'p') continue;
    paraCount++;
    if (paraCount < MIN_PARA) continue;

    const runs = getElementsWithLocalName(node, 'r');
    for (const r of runs) {
      // bandeau image autonome : une image, pas de texte, pas de zone de titre
      if (getElementsWithLocalName(r, 'blip').length === 0) continue;
      if (getElementsWithLocalName(r, 't').length > 0) continue;
      if (getElementsWithLocalName(r, 'txbxContent').length > 0) continue;
      const anchors = getElementsWithLocalName(r, 'anchor');
      for (const a of anchors) {
        if (a.getAttribute('behindDoc') !== '1') continue;
        const extent = findLocalNameChild(a, 'extent');
        if (!extent) continue;
        const wCm = parseInt(extent.getAttribute('cx') || '0', 10) / 914400 * 2.54;
        const hCm = parseInt(extent.getAttribute('cy') || '0', 10) / 914400 * 2.54;
        // Pleine largeur mais court : c'est le bandeau de titre, pas le fond pleine page
        if (wCm >= 19 && hCm >= 2 && hCm <= MAX_H_CM) return r;
      }
    }
  }
  return null;
}

/**
 * Injecte un clone du bandeau « GSS » dans le premier paragraphe d'en-tête d'une page
 * clonée, afin que chaque titre généré porte le logo GSS comme sur les pages du template.
 */
function injectGssBanner(headingParas: any[], gssRun: any, counter: { v: number }) {
  if (!gssRun || headingParas.length === 0) return;
  const clone = gssRun.cloneNode(true);
  renumberDrawingIds(clone, counter);
  const firstPara = headingParas[0];
  firstPara.insertBefore(clone, firstPara.firstChild);
}

/** Plus grand id de dessin présent (wp:docPr / pic:cNvPr) — base pour la renumérotation. */
function maxDrawingId(xmlDoc: any): number {
  let max = 0;
  ['docPr', 'cNvPr'].forEach(name => {
    getElementsWithLocalName(xmlDoc.documentElement, name).forEach((el: any) => {
      const id = parseInt(el.getAttribute('id') || '0', 10);
      if (id > max) max = id;
    });
  });
  return max;
}

/** Réattribue un id unique à chaque dessin (wp:docPr / pic:cNvPr) d'un sous-arbre cloné. */
function renumberDrawingIds(node: any, counter: { v: number }) {
  ['docPr', 'cNvPr'].forEach(name => {
    getElementsWithLocalName(node, name).forEach((el: any) => { el.setAttribute('id', String(++counter.v)); });
  });
}

/**
 * Remplace le texte de toutes les zones de titre (txbxContent) de la section par `title`.
 * Le titre est mis en MAJUSCULES pour respecter l'écriture des titres du template
 * (ex. « NOS AGENTS CYNOPHILES », « NOS PREVENTEURS »).
 */
function setSectionHeading(paras: any[], title: string) {
  const upper = String(title || '').toUpperCase();
  paras.forEach(p => {
    getElementsWithLocalName(p, 'txbxContent').forEach((tx: any) => {
      const tEls = getElementsWithLocalName(tx, 't');
      if (tEls.length === 0) return;
      tEls[0].textContent = upper;
      for (let i = 1; i < tEls.length; i++) tEls[i].textContent = '';
    });
  });
}

/** Découpe le texte généré en lignes de paragraphe (sans markdown, le mode B n'en produit pas). */
function bodyTextToLines(text: string): string[] {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[*_`#]+/g, '')              // garde-fou : retire un éventuel markdown résiduel
    .split('\n')
    .map(l => l.trim());
}

/**
 * Marqueur des zones éditables « Contexte sur mesure ». Une zone est ENCADRÉE par une balise
 * OUVRANTE (« Contexte sur mesure » ou « … début ») et une balise FERMANTE (« … fin »). Les
 * paragraphes vides entre les deux matérialisent l'espace réservé sur la page : le texte injecté
 * y est borné pour ne PAS casser la mise en forme (déborder sur la page conçue suivante).
 */
const CONTEXT_MARKER_RE = /contexte\s+sur\s+mesure/i;
/** Balise FERMANTE d'une zone (« Contexte sur mesure fin »). */
const CONTEXT_CLOSE_RE = /contexte\s+sur\s+mesure\s+fin/i;
// Largeur de découpe (caractères) garantissant qu'une ligne tient sur UNE seule ligne physique
// (sinon le paragraphe déborde sur 2 lignes → décale tout le reste). On CONSERVE l'indentation native
// des lignes réservées (le cadrage voulu) : la largeur utile est donc réduite. Calé sur la géométrie
// d'AO RNE : colonne 2-col ≈ 5644 twips − indent 1906, texte 1-col ≈ 11485 − 1906, police sz 23.
// À AUGMENTER si l'espace réservé reste trop vide ; à RÉDUIRE si une ligne déborde.
const CHARS_PER_LINE_2COL = 26;
const CHARS_PER_LINE_1COL = 68;

/** Vrai si le nœud est à l'intérieur d'une zone de texte Word (txbxContent). */
function isInsideTextbox(node: any): boolean {
  let n = node ? node.parentNode : null;
  while (n) { if (n.localName === 'txbxContent') return true; n = n.parentNode; }
  return false;
}

/** Texte concaténé des runs d'un paragraphe (le texte peut être éclaté en plusieurs `<w:t>`). */
function paragraphText(p: any): string {
  return getElementsWithLocalName(p, 't').map((t: any) => t.textContent || '').join('');
}

/** Écrit `text` dans un paragraphe : tout dans le 1er run, les autres `<w:t>` vidés (style conservé). */
function setParagraphText(p: any, text: string) {
  const tEls = getElementsWithLocalName(p, 't');
  if (tEls.length === 0) return;
  tEls[0].textContent = text;
  // Préserver les espaces de début/fin si présents (texte justifié).
  if (/^\s|\s$/.test(text)) tEls[0].setAttribute('xml:space', 'preserve');
  for (let i = 1; i < tEls.length; i++) tEls[i].textContent = '';
}

/** Vrai si le paragraphe porte un saut de section (sectPr) — structurel (définit les colonnes), à ne JAMAIS toucher. */
function paragraphHasSectPr(p: any): boolean {
  const pPr = findLocalNameChild(p, 'pPr');
  return !!(pPr && findLocalNameChild(pPr, 'sectPr'));
}

/** Vrai si le paragraphe est « vide » : aucun texte, aucune image/dessin, aucun saut de section (ligne blanche de gabarit). */
function isBlankFillerParagraph(p: any): boolean {
  const hasText = getElementsWithLocalName(p, 't').some((t: any) => (t.textContent || '').trim() !== '');
  const hasDrawing = getElementsWithLocalName(p, 'drawing').length > 0 || getElementsWithLocalName(p, 'pict').length > 0;
  return !hasText && !hasDrawing && !paragraphHasSectPr(p);
}

/**
 * Écrit `text` dans un paragraphe en préservant SA mise en forme et SA section (colonnes). Les
 * lignes vides du gabarit n'ont souvent pas de run/`<w:t>` : on en crée un, en reprenant le `rPr`
 * de la marque de paragraphe (`pPr/rPr`) pour conserver police et taille du gabarit.
 */
function fillParagraphText(p: any, text: string) {
  if (getElementsWithLocalName(p, 't').length > 0) { setParagraphText(p, text); return; }
  const doc = p.ownerDocument;
  const r = doc.createElementNS(W_NS, 'w:r');
  const pPr = findLocalNameChild(p, 'pPr');
  const markRPr = pPr ? findLocalNameChild(pPr, 'rPr') : null;
  if (markRPr) r.appendChild(markRPr.cloneNode(true));   // police/taille de la ligne réservée
  const t = doc.createElementNS(W_NS, 'w:t');
  t.setAttribute('xml:space', 'preserve');
  t.textContent = text;
  r.appendChild(t);
  p.appendChild(r);
}

/**
 * Repère, dans l'ordre du document, les paragraphes-marqueurs « Contexte sur mesure » du corps
 * (hors zones de texte). Travaille au niveau paragraphe car le marqueur peut être éclaté en runs.
 */
function findContextMarkers(body: any): any[] {
  return getElementsWithLocalName(body, 'p').filter((p: any) =>
    !isInsideTextbox(p) && CONTEXT_MARKER_RE.test(paragraphText(p)),
  );
}

/**
 * Une zone éditable. `blanks` = lignes vides réservées AVANT l'ancre (déjà en 2 colonnes) ;
 * `postBlanks` = lignes vides réservées APRÈS l'ancre, jusqu'à la fermante (généralement 1 colonne).
 * On ne remplit QUE ces lignes vides existantes, jamais d'ajout/suppression → le nombre de
 * paragraphes reste constant et rien ne se décale en dessous (titres, sections suivantes).
 */
interface ContextZone { open: any; close: any; anchor: any; blanks: any[]; postBlanks: any[]; }

/** sectPr d'un paragraphe (ou null). */
function paragraphSectPr(p: any): any | null {
  const pPr = findLocalNameChild(p, 'pPr');
  return pPr ? findLocalNameChild(pPr, 'sectPr') : null;
}

/** Vrai si ce sectPr met la section en 2 colonnes (w:cols w:num="2"). */
function sectPrIsTwoCol(sectPr: any): boolean {
  if (!sectPr) return false;
  const cols = findLocalNameChild(sectPr, 'cols');
  return !!cols && (cols.getAttribute('w:num') || '') === '2';
}

/** Découpe `text` en lignes de ≤ `maxChars` caractères sans couper les mots (les mots trop longs sont coupés). */
function wrapToLines(text: string, maxChars: number): string[] {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    while (w.length > maxChars) {                       // mot plus long que la ligne → on le coupe
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Apparie les balises « Contexte sur mesure » en zones [ouvrante → fermante]. L'ANCRE = 1er paragraphe
 * à sectPr 2 colonnes entre les balises (la section 2 colonnes s'achève sur lui). Les lignes vides
 * AVANT l'ancre (`blanks`) sont donc en 2 colonnes ; celles APRÈS (`postBlanks`) en 1 colonne. Sans
 * sectPr 2 colonnes on se rabat sur la fermante (tout en 1 colonne). Fermantes orphelines ignorées.
 */
function findContextZones(body: any): ContextZone[] {
  const markers = findContextMarkers(body);
  const zones: ContextZone[] = [];
  for (let i = 0; i < markers.length; i++) {
    const open = markers[i];
    if (CONTEXT_CLOSE_RE.test(paragraphText(open))) continue;   // fermante seule → ignorée
    let close: any = null, ci = -1;
    for (let j = i + 1; j < markers.length; j++) {
      if (CONTEXT_CLOSE_RE.test(paragraphText(markers[j]))) { close = markers[j]; ci = j; break; }
    }
    if (!close) break;                                          // plus de fermante → fin du document
    if (open.parentNode !== close.parentNode) { i = ci; continue; }
    let anchor: any = null;
    for (let n = open.nextSibling; n && n !== close; n = n.nextSibling) {
      if (n.nodeType === 1 && n.localName === 'p' && sectPrIsTwoCol(paragraphSectPr(n))) { anchor = n; break; }
    }
    if (!anchor) anchor = close;                                // repli : pas de section 2 colonnes
    const blanks: any[] = [];      // lignes vides 2 colonnes (avant l'ancre)
    for (let n = open.nextSibling; n && n !== anchor; n = n.nextSibling) {
      if (n.nodeType === 1 && n.localName === 'p' && isBlankFillerParagraph(n)) blanks.push(n);
    }
    const postBlanks: any[] = [];  // lignes vides 1 colonne (après l'ancre, jusqu'à la fermante)
    if (anchor !== close) {
      for (let n = anchor.nextSibling; n && n !== close; n = n.nextSibling) {
        if (n.nodeType === 1 && n.localName === 'p' && isBlankFillerParagraph(n)) postBlanks.push(n);
      }
    }
    zones.push({ open, close, anchor, blanks, postBlanks });
    i = ci;                                                     // reprendre après la fermante consommée
  }
  return zones;
}

/**
 * Remplit les zones éditables SANS jamais changer le nombre de paragraphes (donc sans décaler les
 * titres/sections en dessous). Principe : le texte est découpé en lignes calibrées pour tenir sur UNE
 * ligne physique, puis écrit DANS les lignes vides déjà réservées (d'abord les lignes 2 colonnes, puis
 * les lignes 1 colonne). Si le texte dépasse le nombre de lignes réservées → tronqué ; s'il est plus
 * court → les lignes vides restantes conservent l'espace. Répartition ÉQUILIBRÉE entre les zones pour
 * étaler le texte sur toutes les pages. Renvoie un récap pour le log.
 */
function fillContextMarkers(body: any, generatedText: string): { markers: number; pagesUsed: number; truncated: boolean; linesFilled: number } {
  const zones = findContextZones(body);
  if (zones.length === 0) return { markers: 0, pagesUsed: 0, truncated: false, linesFilled: 0 };

  const paras = bodyTextToLines(generatedText).filter((l) => l.length > 0);
  const N = zones.length;
  // Largeur de découpe et capacité (en caractères) par zone : 2 colonnes si la zone a des lignes 2-col.
  const wrapWidth = zones.map((z) => (z.blanks.length > 0 ? CHARS_PER_LINE_2COL : CHARS_PER_LINE_1COL));
  const lineBudget = zones.map((z) => z.blanks.length + z.postBlanks.length);
  const charCap = zones.map((_, i) => lineBudget[i] * wrapWidth[i]);

  // Cible par zone = part équilibrée (total / N), plafonnée par la capacité (espace réservé) de la zone.
  const totalChars = paras.reduce((s, p) => s + p.length + 1, 0);
  const share = Math.max(1, Math.ceil(totalChars / N));
  const targets = charCap.map((c) => Math.min(c, share));

  // Répartition séquentielle des paragraphes : on remplit la zone i jusqu'à sa cible, puis i+1.
  const chunks: string[][] = Array.from({ length: N }, () => []);
  let zi = 0, used = 0, truncated = false;
  for (const para of paras) {
    while (zi < N && chunks[zi].length > 0 && used + para.length > targets[zi]) { zi++; used = 0; }
    if (zi >= N) { truncated = true; break; }
    chunks[zi].push(para);
    used += para.length + 1;
  }

  let pagesUsed = 0, linesFilled = 0;
  zones.forEach((z, idx) => {
    // Vider les balises (placeholders) sans rien ajouter/retirer — elles restent des paragraphes vides.
    setParagraphText(z.open, '');
    setParagraphText(z.close, '');
    if (chunks[idx].length === 0) return;
    pagesUsed++;

    // Découper le texte de la zone en lignes physiques contiguës (pas de ligne vide intercalée, qui
    // créerait de gros trous : l'espacement natif des lignes réservées suffit à aérer le texte).
    const phys: string[] = [];
    chunks[idx].forEach((para) => {
      wrapToLines(para, wrapWidth[idx]).forEach((l) => phys.push(l));
    });

    // Écrire UNE ligne par ligne vide réservée (2 colonnes d'abord, puis 1 colonne), en CONSERVANT
    // intégralement la mise en forme native (indentation/cadrage, police, espacement). Aucun paragraphe
    // n'est ajouté ni supprimé → mise en page en dessous inchangée. Surplus tronqué, manque laissé vide.
    const slots = [...z.blanks, ...z.postBlanks];
    if (phys.length > slots.length) truncated = true;
    for (let i = 0; i < slots.length && i < phys.length; i++) {
      fillParagraphText(slots[i], phys[i]);
      linesFilled++;
    }
  });

  return { markers: N, pagesUsed, truncated, linesFilled };
}

/**
 * Refonte V1 — sur une page DUPLIQUÉE, retire UNIQUEMENT les images de fond
 * PLEINE PAGE (photo de décor, anchor `behindDoc="1"` de taille ~21×29.7cm) afin de
 * laisser apparaître le fond gris uniforme. On préserve :
 *  - les runs porteurs d'une zone de titre (`txbxContent`) ;
 *  - le bandeau de titre « GSS » (image behindDoc large mais PEU haute, ~21×3.3cm),
 *    qui doit rester sur chaque titre.
 * Le critère discriminant est donc la HAUTEUR pleine page (≥ 20cm).
 * Renvoie le nombre de runs-images retirés.
 */
function stripStandaloneBgImages(paras: any[]): number {
  const FULLPAGE_MIN_H_CM = 20; // au-delà : fond pleine page ; en deçà : bandeau de titre, etc.
  let removed = 0;
  paras.forEach((p) => {
    const runs = getElementsWithLocalName(p, 'r');
    runs.forEach((r: any) => {
      const anchors = getElementsWithLocalName(r, 'anchor');
      const isFullPageBg = anchors.some((a: any) => {
        if (a.getAttribute('behindDoc') !== '1') return false;
        const extent = findLocalNameChild(a, 'extent');
        const cy = extent ? parseInt(extent.getAttribute('cy') || '0', 10) : 0;
        return (cy / 914400 * 2.54) >= FULLPAGE_MIN_H_CM;
      });
      const hasBlip = getElementsWithLocalName(r, 'blip').length > 0;
      const hasTitle = getElementsWithLocalName(r, 'txbxContent').length > 0;
      if (isFullPageBg && hasBlip && !hasTitle && r.parentNode) {
        r.parentNode.removeChild(r);
        removed++;
      }
    });
  });
  return removed;
}

/** Force la couleur de tous les runs (texte) d'un sous-arbre — lisibilité sur fond gris. */
function forceTextColor(paras: any[], color: string) {
  paras.forEach((p) => {
    getElementsWithLocalName(p, 'r').forEach((r: any) => {
      // ne pas toucher aux runs purement graphiques (drawing/pict) sans texte
      if (getElementsWithLocalName(r, 't').length === 0) return;
      let rPr = findLocalNameChild(r, 'rPr');
      if (!rPr) {
        rPr = r.ownerDocument.createElementNS(W_NS, 'w:rPr');
        r.insertBefore(rPr, r.firstChild);
      }
      let col = findLocalNameChild(rPr, 'color');
      if (!col) {
        col = r.ownerDocument.createElementNS(W_NS, 'w:color');
        rPr.appendChild(col);
      }
      col.setAttribute('w:val', color);
    });
  });
}

/**
 * Clone un spread (sections [titre+image] + [corps]) en injectant `title`
 * (zone de titre) et `bodyText` (corps), avec ids de dessin renumérotés. Renvoie les
 * nouveaux paragraphes prêts à être insérés. Préserve le sectPr d'origine de chaque
 * section (mise en page identique).
 *
 * Refonte V1 (`refonte=true`) : retire les images de fond pleine page des pages
 * dupliquées (fond gris uniforme à la place) et force le texte en sombre (lisibilité).
 */
function cloneSpread(
  xmlDoc: any, headingParas: any[], bodyParas: any[], counter: { v: number }, title: string, bodyText: string,
  refonte = false, stats?: { imagesRemoved: number },
): any[] {
  const newHeading = headingParas.map(p => p.cloneNode(true));
  newHeading.forEach(p => renumberDrawingIds(p, counter));
  if (title) setSectionHeading(newHeading, title);

  // Refonte V1 : sur la page dupliquée, retire l'image de fond pleine page (le
  // titre/bandeau est conservé) et force le texte en sombre pour rester lisible
  // sur le fond gris uniforme injecté au niveau du document.
  if (refonte) {
    const removed = stripStandaloneBgImages(newHeading);
    if (stats) stats.imagesRemoved += removed;
    forceTextColor(newHeading, DUP_TEXT_COLOR);
  }

  const lastBody = bodyParas[bodyParas.length - 1];
  const origSectPr = lastBody ? findLocalNameChild(findLocalNameChild(lastBody, 'pPr'), 'sectPr') : null;
  const sectPrClone = origSectPr ? origSectPr.cloneNode(true) : null;

  const lines = bodyTextToLines(bodyText);
  const newBody: any[] = [];

  // Pour conserver parfaitement la DA (Art Direction), on clone le premier paragraphe du template
  let templateP = bodyParas.find(p => getElementsWithLocalName(p, 't').length > 0) || bodyParas[0];

  if (!templateP) {
    // Fallback de sécurité (très rare)
    templateP = xmlDoc.createElementNS(W_NS, 'w:p');
  }

  lines.forEach((ln, idx) => {
    const pClone = templateP.cloneNode(true);

    // On retire le sectPr du clone (car sectPr ne doit être que sur le DERNIER paragraphe)
    let pPr = findLocalNameChild(pClone, 'pPr');
    if (pPr) {
      const sectPr = findLocalNameChild(pPr, 'sectPr');
      if (sectPr) pPr.removeChild(sectPr);
    } else {
      pPr = xmlDoc.createElementNS(W_NS, 'w:pPr');
      pClone.insertBefore(pPr, pClone.firstChild);
    }

    // Le user a explicitement demandé de RECENTRER le texte
    let jc = findLocalNameChild(pPr, 'jc');
    if (!jc) {
      jc = xmlDoc.createElementNS(W_NS, 'w:jc');
      pPr.appendChild(jc);
    }
    jc.setAttribute('w:val', 'center');

    // On conserve un bon espacement aéré
    let spacing = findLocalNameChild(pPr, 'spacing');
    if (!spacing) {
      spacing = xmlDoc.createElementNS(W_NS, 'w:spacing');
      pPr.appendChild(spacing);
    }
    spacing.setAttribute('w:after', '280'); // 14pt

    // Remplacement du texte tout en gardant les propriétés de police (rPr)
    const runs = getElementsWithLocalName(pClone, 'r');
    if (runs.length > 0) {
      // On garde uniquement le premier "run" pour éviter la duplication de styles hétérogènes
      for (let i = 1; i < runs.length; i++) {
        pClone.removeChild(runs[i]);
      }
      const tEls = getElementsWithLocalName(runs[0], 't');
      if (tEls.length > 0) {
        tEls[0].textContent = ln;
        tEls[0].setAttribute('xml:space', 'preserve');
        for (let i = 1; i < tEls.length; i++) runs[0].removeChild(tEls[i]);
      } else {
        const t = xmlDoc.createElementNS(W_NS, 'w:t');
        t.textContent = ln;
        t.setAttribute('xml:space', 'preserve');
        runs[0].appendChild(t);
      }
    } else {
      const r = xmlDoc.createElementNS(W_NS, 'w:r');
      const t = xmlDoc.createElementNS(W_NS, 'w:t');
      t.textContent = ln;
      t.setAttribute('xml:space', 'preserve');
      r.appendChild(t);
      pClone.appendChild(r);
    }

    // Le dernier paragraphe doit porter les propriétés de section (colonnes, marges, etc.)
    if (idx === lines.length - 1 && sectPrClone) {
      pPr.appendChild(sectPrClone);
    }

    newBody.push(pClone);
  });

  // Refonte V1 : corps de texte en sombre, lisible sur le fond gris uniforme.
  if (refonte) forceTextColor(newBody, DUP_TEXT_COLOR);

  return [...newHeading, ...newBody];
}

// ─── Construction d'un mémoire PROPRE (XML en chaîne, zéro DOM) ───
// On ne touche plus jamais au DOM d'AO RNE (le re-sérialiser dégrade sa maquette).
// À la place, on génère un document.xml NEUF, dont le rendu reprend l'identité
// visuelle d'AO RNE : fond anthracite, texte crème, titres clairs, accent vert GSS.

// Palette extraite d'AO RNE.docx (couleurs dominantes du design).
const COL_BG = '494545';       // fond de page anthracite
const COL_TITLE = 'FFFFFF';    // titres (blanc)
const COL_BODY = 'EFE7D3';     // corps de texte (crème, lisible sur fond sombre)
const COL_ACCENT = 'C81E1E';   // rouge GSS (filets / labels)
const COL_MUTED = 'D9D9D9';    // gris clair (sous-texte)

// ─── Refonte V1 : fond gris uniforme sur les pages dupliquées ───
// Couleur de fond de page (Word: <w:background>). Gris clair lisible, configurable.
// Repli possible sur 'FFFFFF' si le rendu Word pose problème (cf. garde-fou).
const BACKGROUND_COLOR = 'E5E5E5';
// Couleur de texte forcée sur les pages dupliquées (lisible sur fond gris clair).
const DUP_TEXT_COLOR = '1A1A1A';

// Tailles en demi-points (22 = 11 pt) ; espacements en twips (240 = 12 pt).
const SZ_BODY = 22;
const SZ_SECTION = 30;     // titre de section 15 pt
const SZ_SUBHEAD = 26;
const SZ_SUBHEAD2 = 24;
const SZ_CHAPTER = 40;     // titre de chapitre 20 pt
const LINE_AUTO = 276;     // interligne 1,15
const FONT = 'Trebuchet MS';

function escXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface RunOpts { bold?: boolean; italic?: boolean; size?: number; color?: string; }
interface ParaOpts {
  align?: 'left' | 'center' | 'right' | 'both';
  before?: number; after?: number; line?: number;
  indent?: number; bullet?: boolean;
  accentRule?: boolean;   // filet vert sous le paragraphe (titres de chapitre)
  pageBreak?: boolean;    // saut de page avant
}

/** Run <w:r> en chaîne, police Trebuchet par défaut. */
function runX(text: string, o: RunOpts = {}): string {
  let rpr = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`;
  if (o.bold) rpr += '<w:b/>';
  if (o.italic) rpr += '<w:i/>';
  if (o.color) rpr += `<w:color w:val="${o.color}"/>`;
  if (o.size) rpr += `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>`;
  return `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`;
}

/** Paragraphe <w:p> en chaîne à partir de runs déjà sérialisés. */
function paraX(innerRuns: string, o: ParaOpts = {}): string {
  const { align, before = 0, after = 120, line = LINE_AUTO, indent = 0, bullet = false } = o;
  let ppr = '';
  if (o.pageBreak) ppr += '<w:pageBreakBefore/>';
  const left = bullet ? Math.max(indent, 360) : indent;
  if (left) ppr += `<w:ind w:left="${left}"${bullet ? ' w:hanging="240"' : ''}/>`;
  if (o.accentRule) ppr += `<w:pBdr><w:bottom w:val="single" w:sz="14" w:space="6" w:color="${COL_ACCENT}"/></w:pBdr>`;
  ppr += `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>`;
  if (align) ppr += `<w:jc w:val="${align}"/>`;
  return `<w:p><w:pPr>${ppr}</w:pPr>${innerRuns}</w:p>`;
}

/** Découpe un texte selon le markdown inline (**gras**, __gras__, *italique*). */
function parseInlineMarkdown(text: string): Array<{ text: string; bold?: boolean; italic?: boolean }> {
  const segs: Array<{ text: string; bold?: boolean; italic?: boolean }> = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) segs.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) segs.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) segs.push({ text: m[3], italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.filter((s) => s.text && s.text.length > 0);
}

/** Runs d'une ligne, markdown inline rendu, sur une base de style (couleur/taille). */
function inlineX(text: string, base: RunOpts): string {
  const segs = parseInlineMarkdown(text);
  if (segs.length === 0) return runX(text, base);
  return segs.map((s) => runX(s.text, { ...base, bold: base.bold || s.bold, italic: s.italic })).join('');
}

/** Normalise un titre pour comparer (minuscules, sans accents ni ponctuation). */
function normTitle(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Convertit un bloc markdown en paragraphes <w:p> (chaîne), couleur crème par défaut.
 * `skipTitle` : omet la 1re ligne si c'est un titre quasi identique au titre de section
 * (l'IA répète souvent le titre en tête de réponse).
 */
function markdownToParagraphsX(raw: string, skipTitle?: string): string {
  const out: string[] = [];
  const skipNorm = skipTitle ? normTitle(skipTitle) : '';
  let firstContent = true;
  const isDup = (t: string) => {
    if (!skipNorm) return false;
    const n = normTitle(t);
    return n === skipNorm || (n.length > 6 && (skipNorm.includes(n) || n.includes(skipNorm)));
  };

  for (const rawLine of String(raw || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\t/g, ' ').replace(/`+/g, '').trimEnd();
    const t = line.trim();
    if (t === '' || /^[-*_]{3,}$/.test(t)) continue;

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (firstContent && isDup(h[2])) { firstContent = false; continue; }
      firstContent = false;
      const sz = h[1].length <= 1 ? SZ_SUBHEAD : SZ_SUBHEAD2;
      out.push(paraX(inlineX(h[2], { bold: true, size: sz, color: COL_TITLE }), { before: 200, after: 100 }));
      continue;
    }
    const bo = t.match(/^\*\*(.+?)\*\*:?\.?$/);
    if (bo) {
      if (firstContent && isDup(bo[1])) { firstContent = false; continue; }
      firstContent = false;
      out.push(paraX(inlineX(bo[1], { bold: true, size: SZ_SUBHEAD2, color: COL_TITLE }), { before: 160, after: 80 }));
      continue;
    }
    firstContent = false;

    const bullet = t.match(/^[-*+•]\s+(.*)$/);
    if (bullet) {
      out.push(paraX(runX('•\t', { size: SZ_BODY, color: COL_ACCENT, bold: true }) + inlineX(bullet[1], { size: SZ_BODY, color: COL_BODY }), { bullet: true, after: 80 }));
      continue;
    }
    const num = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (num) {
      out.push(paraX(runX(`${num[1]}.\t`, { size: SZ_BODY, color: COL_ACCENT, bold: true }) + inlineX(num[2], { size: SZ_BODY, color: COL_BODY }), { indent: 360, after: 80 }));
      continue;
    }
    out.push(paraX(inlineX(t, { size: SZ_BODY, color: COL_BODY }), { align: 'both', after: 140 }));
  }
  return out.join('');
}

export interface AssembleChapter {
  /** Chapitre I..IV (ordre = ordre des Heading1 dans le template). */
  key: string;
  title: string;
  sections: Array<{ title: string; text: string }>;
}

// ─── Mode B (réponse libre / sans cadre imposé) ───
// Mapping miroir de frontend/lib/ai/sections-b.ts : permet de regrouper la map
// plate {id_section: texte} renvoyée par l'export front en chapitres I..IV.
const CHAPTER_TITLES_B: Record<string, string> = {
  I: 'Présentation de notre structure',
  II: 'Les moyens humains',
  III: 'Les moyens opérationnels',
  IV: 'Les moyens organisationnels',
};

const AI_SECTIONS_B: Array<{ id: string; chapter: string; title: string }> = [
  // I — Présentation de notre structure
  { id: 'b_presentation', chapter: 'I', title: 'Présentation de la société GSS' },
  { id: 'b_implantation', chapter: 'I', title: 'Implantation régionale et agences de proximité' },
  { id: 'b_agrements', chapter: 'I', title: 'Autorisations, agréments CNAPS et conformité légale' },
  { id: 'b_engagement_rse', chapter: 'I', title: 'Engagement RSE et écologique' },
  // II — Les moyens humains
  { id: 'b_moyens_humains', chapter: 'II', title: 'Qualifications et profils des agents (CQP APS, SSIAP)' },
  { id: 'b_encadrement', chapter: 'II', title: 'Encadrement et organigramme opérationnel' },
  { id: 'b_reprise_personnel', chapter: 'II', title: 'Reprise du personnel en place (article L1224-1)' },
  { id: 'b_recrutement_formation', chapter: 'II', title: 'Recrutement, formation et montée en compétences' },
  { id: 'b_dispositif_absence', chapter: 'II', title: "Dispositif palliatif d'absence et remplacement" },
  { id: 'b_tenues_epi', chapter: 'II', title: 'Tenues et équipements de protection des agents' },
  // III — Les moyens opérationnels
  { id: 'b_moyens_materiels', chapter: 'III', title: 'Moyens matériels et équipements' },
  { id: 'b_rondes', chapter: 'III', title: 'Rondes, pointeaux et main courante électronique' },
  { id: 'b_controle_acces', chapter: 'III', title: 'Gestion des accès et contrôle des flux' },
  { id: 'b_telesurveillance', chapter: 'III', title: 'Télésurveillance et levée de doute (lot 3)' },
  { id: 'b_gestion_alarmes', chapter: 'III', title: "Gestion des alarmes et procédures d'intervention" },
  // IV — Les moyens organisationnels
  { id: 'b_organisation', chapter: 'IV', title: 'Organisation et démarrage de la prestation' },
  { id: 'b_planning', chapter: 'IV', title: 'Plannings et continuité de service' },
  { id: 'b_suivi_qualite', chapter: 'IV', title: 'Suivi qualité, contrôles inopinés et reporting' },
  { id: 'b_procedures', chapter: 'IV', title: 'Procédures opérationnelles et gestion des incidents' },
  { id: 'b_amelioration', chapter: 'IV', title: 'Amélioration continue et bilan de prestation' },
];

const CHAPTER_ORDER_B = ['I', 'II', 'III', 'IV'];

// ─── Mapping Documentation GSS → sections du mémoire ───
// Associe chaque catégorie de la Documentation GSS (21 dossiers PDF) aux mots-clés
// des spreads d'AO RNE.docx pour sélectionner automatiquement les sources pertinentes.
const GSS_DOC_KEYWORDS: Record<string, string[]> = {
  'ABSENCE ET RETARD': ['absence', 'retard', 'remplacement', 'palliatif', 'indisponibilite'],
  'EFFECTIFS ET ORGANIGRAMME': ['effectif', 'organigramme', 'encadrement', 'equipe', 'structure', 'moyens humains'],
  'ENGAGEMENT ECOLOGIQUE': ['ecologique', 'rse', 'environnement', 'durable', 'responsabilite'],
  'FORMATION': ['formation', 'competence', 'qualification', 'cqp', 'ssiap', 'mac'],
  'FORMATION INTERNE': ['formation interne', 'parcours', 'montee en competence', 'habilitation'],
  'INTERLOCUTEUR UNIQUE': ['interlocuteur', 'contact unique', 'referent', 'proximite'],
  'LMC': ['main courante electronique', 'lmc', 'logiciel'],
  'MAIN COURANTE': ['main courante', 'rapport', 'evenement', 'ronde', 'pointeau'],
  'MANAGEMENT': ['management', 'direction', 'presentation', 'societe', 'pilotage', 'qui sommes'],
  'MATERIEL': ['materiel', 'equipement', 'moyen technique', 'outil', 'vehicule', 'radio', 'pti', 'dati', 'communication'],
  'MISE EN PLACE': ['mise en place', 'demarrage', 'lancement', 'deploiement', 'phase preparatoire'],
  "MOYENS D'ACCES": ['acces', 'cle', 'badge', 'controle acces', 'securisation', 'flux'],
  'NOUVEAU MARCHE': ['nouveau marche', 'reprise', 'transition', 'personnel en place', 'l1224', 'prise de poste'],
  'NOUVEL AGENT': ['integration', 'nouvel agent', 'accueil'],
  'PARTENAIRES': ['partenaire', 'sous-traitant', 'prestataire'],
  'PLANNIFICATION': ['planning', 'planification', 'vacation', 'horaire', 'continuite', 'service'],
  'PROCEDURE': ['procedure', 'incident', 'alarme', 'intrusion', 'incendie', 'intervention', 'suspect', 'victime', 'perturbateur', 'consigne'],
  'RECRUTEMENT': ['recrutement', 'embauche', 'selection', 'candidat', 'profil'],
  'SUIVI QUALITE ET CONTROLES': ['qualite', 'controle', 'inopine', 'audit', 'suivi', 'reporting', 'indicateur', 'amelioration'],
  'TENUES': ['tenue', 'vestiaire', 'uniforme', 'epi', 'equipement de protection', 'habillement'],
  'VALEURS': ['valeur', 'engagement', 'ethique', 'mission', 'vision'],
};

// ─── Solutions GSS spécifiques par section × type de marché (public / privé) ───
// Pour chaque thématique du mémoire, liste les arguments stratégiques GSS différenciants
// selon que le client est un acheteur public (Code de la commande publique) ou privé.
// `common` = applicable quel que soit le cadre. Utilisé pour enrichir les prompts IA.

interface GssSolutionSet { public: string[]; prive: string[]; common: string[]; }
const GSS_SOLUTIONS_BY_CONTEXT: Record<string, GssSolutionSet> = {
  // ── I — Présentation de notre structure ──
  'presentation': {
    public: [
      `Conformité au Code de la commande publique (art. L2141-1 et suivants) et transparence des procédures`,
      `Référencement sur plateformes de dématérialisation (PLACE, AWS, profils acheteurs)`,
      `Expérience avérée auprès de collectivités territoriales, EPCI, universités et établissements publics`,
      `Capacité à produire les attestations fiscales et sociales exigées (DC1/DC2, NOTI1/NOTI2)`,
    ],
    prive: [
      `Souplesse contractuelle et adaptation rapide aux besoins évolutifs du client`,
      `Interlocuteur unique dédié avec engagement de réactivité < 1h`,
      `SLA personnalisés avec indicateurs de performance et bonus/malus`,
      `Confidentialité renforcée (NDA, habilitations spécifiques au secteur)`,
    ],
    common: [
      `Agréments CNAPS et autorisations préfectorales à jour sur toute la zone géographique`,
      `Assurance responsabilité civile professionnelle couvrant l'intégralité du périmètre`,
      `Certifications qualité (ISO 9001, Qualiopi pour la formation)`,
    ],
  },
  'implantation': {
    public: [
      `Maillage territorial permettant une couverture multi-sites (agences de proximité en région)`,
      `Connaissance des spécificités des ERP (Établissements Recevant du Public) et des campus`,
    ],
    prive: [
      `Implantation locale garantissant un temps d'intervention réduit (< 30 min)`,
      `Bureau opérationnel dédié sur site pour les contrats importants`,
    ],
    common: [
      `Réseau national d'agences GSS avec encadrement régional`,
      `Centre opérationnel 24/7 pour coordination et pilotage à distance`,
    ],
  },
  'agrements': {
    public: [
      `Production systématique de l'extrait K-bis, attestations URSSAF/impôts, casiers judiciaires des dirigeants`,
      `Renouvellement proactif des agréments CNAPS avant échéance (anticipation de 6 mois)`,
      `Conformité aux critères d'exclusion de la commande publique (art. L2141-1 à L2141-11)`,
    ],
    prive: [
      `Audit de conformité réglementaire inclus dans la prestation (veille CNAPS)`,
      `Garantie contractuelle de mise à jour permanente des autorisations`,
    ],
    common: [
      `Autorisation d'exercice CNAPS pour chaque agence du périmètre`,
      `Agréments dirigeants et cartes professionnelles de tous les agents vérifiées`,
    ],
  },
  'engagement_rse': {
    public: [
      `Réponse aux critères environnementaux et sociaux des marchés publics (art. L2112-2 du CCP)`,
      `Clause d'insertion professionnelle et engagement en faveur de l'emploi local`,
      `Bilan carbone annuel et plan de réduction des émissions`,
    ],
    prive: [
      `Labellisation RSE et reporting extra-financier adapté au secteur du client`,
      `Politique de mobilité durable (véhicules électriques/hybrides pour les rondes)`,
    ],
    common: [
      `Flotte de véhicules à faibles émissions pour les interventions`,
      `Dématérialisation complète (main courante électronique, reporting en ligne)`,
      `Politique zéro papier et tri sélectif sur les postes`,
    ],
  },
  // ── II — Les moyens humains ──
  'moyens_humains': {
    public: [
      `Transparence sur les qualifications : CV anonymisés et fiches de poste conformes au CCTP`,
      `Respect des grilles salariales conventionnelles et engagement anti-dumping social`,
      `Taux d'encadrement supérieur aux minimums réglementaires (1 chef d'équipe / 15 agents)`,
    ],
    prive: [
      `Sélection sur mesure des profils en fonction du secteur d'activité du client`,
      `Possibilité de validation préalable des agents par le client (entretien conjoint)`,
      `Programme de fidélisation (prime de site, avantages, parcours de carrière)`,
    ],
    common: [
      `Agents titulaires CQP APS, SSIAP 1/2/3, SST selon les postes`,
      `Vérification systématique carte CNAPS + casier judiciaire à l'embauche`,
      `Formation continue obligatoire (MAC APS, recyclage SSIAP, exercices incendie)`,
    ],
  },
  'encadrement': {
    public: [
      `Organigramme opérationnel dédié au marché, transmis à l'acheteur avec CVs`,
      `Réunions de suivi périodiques (trimestrielles) avec compte-rendu formalisé`,
      `Chef de site SSIAP 2/3 coordinateur sûreté-sécurité selon exigences du CCTP`,
    ],
    prive: [
      `Directeur de compte unique avec disponibilité 7j/7`,
      `Reporting personnalisé selon les KPIs définis conjointement`,
      `Comité de pilotage mensuel avec tableaux de bord opérationnels`,
    ],
    common: [
      `Management de proximité : responsable d'exploitation basé en région`,
      `Chaîne d'astreinte 24/7 (agent → chef d'équipe → responsable exploitation → direction)`,
    ],
  },
  'reprise_personnel': {
    public: [
      `Application stricte de l'article L1224-1 du Code du travail (obligation légale de reprise)`,
      `Transparence totale : entretiens individuels, maintien des droits acquis, information du CSE`,
      `Délai de transition structuré (J-45 à J+15) avec plan de reprise détaillé`,
    ],
    prive: [
      `Reprise volontaire du personnel en place pour garantir la continuité de service`,
      `Audit social préalable (ancienneté, qualifications, souhaits de mobilité)`,
      `Programme d'intégration accéléré aux process et à la culture GSS`,
    ],
    common: [
      `Maintien des conditions salariales et avantages acquis du personnel repris`,
      `Plan de formation passerelle pour mise à niveau aux standards GSS`,
      `Accompagnement RH personnalisé pendant la période de transition (3 mois)`,
    ],
  },
  'recrutement_formation': {
    public: [
      `Plan de formation annuel transmis à l'acheteur (obligation du CCTP)`,
      `Habilitations spécifiques aux sites publics (ERP, ICPE, ZRR, zones sensibles)`,
      `Partenariats avec les CFA et organismes de formation certifiés Qualiopi`,
    ],
    prive: [
      `Formation aux risques spécifiques du secteur client (industriel, logistique, tertiaire)`,
      `E-learning GSS Academy : modules accessibles 24/7 pour montée en compétences continue`,
    ],
    common: [
      `Processus de recrutement rigoureux en 5 étapes (sourcing, entretien, vérifications, formation, intégration)`,
      `Formation initiale renforcée (consignes de poste, procédures GSS, culture client)`,
      `Recyclages MAC APS / SSIAP dans les délais réglementaires`,
    ],
  },
  'dispositif_absence': {
    public: [
      `Engagement contractuel de remplacement en < 2h (pénalité applicable en cas de manquement)`,
      `Volant de réserve régional dimensionné selon les effectifs du marché (ratio 1 réserviste / 8 titulaires)`,
    ],
    prive: [
      `Remplacement garanti en < 1h grâce au vivier de proximité`,
      `Application mobile d'alerte pour mobilisation instantanée des agents disponibles`,
    ],
    common: [
      `Planning prévisionnel avec gestion anticipée des congés, formations et absences prévisibles`,
      `Agents remplaçants formés et habilités sur les consignes spécifiques du site`,
      `Système de binômage : chaque titulaire a un remplaçant attitré connaissant le site`,
    ],
  },
  'tenues_epi': {
    public: [
      `Tenues conformes au CCTP (logo, couleur, identification visible selon arrêté préfectoral)`,
      `Dotation individuelle complète fournie à la prise de poste (pas de partage d'EPI)`,
    ],
    prive: [
      `Personnalisation des tenues aux couleurs et au logo du client (co-branding)`,
      `Adaptation des EPI aux risques spécifiques du site (ATEX, froid, chaleur, chimique)`,
    ],
    common: [
      `Tenue professionnelle complète : veste, pantalon, polo, chaussures de sécurité, badge nominatif`,
      `EPI selon poste : gilet haute visibilité, lampe torche, PTI/DATI, radio`,
      `Renouvellement annuel et suivi de l'état des équipements`,
    ],
  },
  // ── III — Les moyens opérationnels ──
  'moyens_materiels': {
    public: [
      `Inventaire détaillé des équipements affectés au marché (annexe au mémoire)`,
      `Véhicules sérigraphiés conformes aux exigences du CCTP (éco-conduite, géolocalisation)`,
    ],
    prive: [
      `Dotation matérielle évolutive selon les besoins du client (scalabilité)`,
      `Intégration aux systèmes existants du client (vidéosurveillance, contrôle d'accès, GTC)`,
    ],
    common: [
      `Système de contrôle de rondes NFC/QR code avec horodatage et géolocalisation`,
      `PTI/DATI pour protection du travailleur isolé sur chaque agent`,
      `Radios numériques pour communication inter-agents et avec le PC sécurité`,
      `Véhicules d'intervention équipés (gyrophare, premier secours, extincteur)`,
    ],
  },
  'rondes': {
    public: [
      `Points de contrôle (pointeaux NFC) positionnés selon le plan de prévention du CCTP`,
      `Rapports de rondes horodatés consultables par l'acheteur via l'extranet GSS`,
    ],
    prive: [
      `Parcours de rondes personnalisés et modifiables en temps réel via l'application GSS`,
      `Rondes aléatoires programmables pour effet dissuasif renforcé`,
    ],
    common: [
      `Main courante électronique (TrackForce/LMC) : saisie terrain, photos, alertes en temps réel`,
      `Reporting automatique : synthèse quotidienne, hebdomadaire et mensuelle`,
      `Traçabilité complète : chaque ronde, chaque événement est horodaté et géolocalisé`,
    ],
  },
  'controle_acces': {
    public: [
      `Gestion des accès conforme aux exigences ZRR/zone sensible (contrôle visuel + badge)`,
      `Registre des entrées/sorties dématérialisé et consultable par l'administration`,
    ],
    prive: [
      `Interfaçage avec les systèmes de contrôle d'accès existants (NEDAP, TIL, Honeywell)`,
      `Gestion des visiteurs avec pré-enregistrement et QR code d'accès temporaire`,
    ],
    common: [
      `Procédure d'accueil et de filtrage : vérification d'identité, orientation, enregistrement`,
      `Gestion sécurisée des clés et badges (armoire à clés sécurisée, traçabilité)`,
      `Contrôle des livraisons et des prestataires extérieurs`,
    ],
  },
  'telesurveillance': {
    public: [
      `Station de télésurveillance certifiée APSAD P3/P5 (exigence fréquente des marchés publics)`,
      `Délais d'intervention contractuels conformes au CCTP (engagements chiffrés par site)`,
      `Intervenants véhiculés basés à moins de 20 km de chaque site (obligation APSAD)`,
    ],
    prive: [
      `Offre modulable : télésurveillance seule, levée de doute, ou intervention complète`,
      `Vidéosurveillance intelligente avec analyse comportementale (option)`,
    ],
    common: [
      `Centre de télésurveillance opéré 24/7 par des opérateurs qualifiés`,
      `Levée de doute vidéo et/ou physique selon protocole convenu`,
      `Report des alarmes intrusion, technique et incendie avec gestion des priorités`,
    ],
  },
  'gestion_alarmes': {
    public: [
      `Procédures d'intervention formalisées et validées par l'acheteur (annexe au marché)`,
      `Rapport d'intervention transmis sous 24h avec analyse causes/conséquences`,
    ],
    prive: [
      `Procédures d'escalade personnalisées selon la criticité (niveaux 1/2/3)`,
      `Intégration des protocoles d'alerte du client (astreinte direction, cellule de crise)`,
    ],
    common: [
      `Gestion des alarmes selon procédure graduée : vérification → alerte → intervention → rapport`,
      `Coordination avec les forces de l'ordre et services de secours`,
      `Retour d'expérience systématique après chaque incident significatif`,
    ],
  },
  // ── IV — Les moyens organisationnels ──
  'organisation': {
    public: [
      `Phase de transition structurée : visite des sites, rencontre du personnel, validation des consignes`,
      `Plan de démarrage formalisé (J-30 à J+30) présenté à l'acheteur avant la prise d'effet`,
      `Période de tuilage avec le prestataire sortant (si applicable)`,
    ],
    prive: [
      `Audit sécurité gratuit préalable au démarrage (diagnostic des vulnérabilités)`,
      `Mise en place progressive (montée en charge) pour les sites complexes`,
    ],
    common: [
      `Réunion de lancement avec l'ensemble des parties prenantes`,
      `Livret d'accueil et consignes de poste spécifiques au site`,
      `Test opérationnel avant démarrage effectif (simulation d'incident)`,
    ],
  },
  'planning': {
    public: [
      `Plannings mensuels transmis à l'acheteur pour validation avant exécution`,
      `Respect strict des amplitudes horaires et repos réglementaires (Convention collective)`,
      `Gestion des prestations supplémentaires sur devis préalable (bon de commande)`,
    ],
    prive: [
      `Plannings flexibles ajustables en temps réel via l'application GSS`,
      `Adaptation aux pics d'activité et événements exceptionnels du client`,
    ],
    common: [
      `Logiciel de planification Comète/SILAE : optimisation des roulements et continuité`,
      `Couverture 24/7 garantie avec chevauchements de vacation pour le passage de consignes`,
      `Anticipation des congés et formations : planning prévisionnel à 3 mois`,
    ],
  },
  'suivi_qualite': {
    public: [
      `Contrôles inopinés mensuels avec rapport transmis à l'acheteur`,
      `Réunions de suivi trimestrielles avec indicateurs de performance (taux de couverture, incidents, remplacements)`,
      `Extranet client : accès temps réel aux mains courantes, plannings et rapports`,
    ],
    prive: [
      `Dashboard personnalisé avec KPIs définis conjointement (SLA, satisfaction, incidents)`,
      `Enquête de satisfaction semestrielle auprès des utilisateurs du site`,
    ],
    common: [
      `Plan d'assurance qualité (PAQ) formalisé et mis à jour annuellement`,
      `Audit interne semestriel par la direction qualité GSS`,
      `Traçabilité complète de toutes les actions (rondes, incidents, remplacements)`,
    ],
  },
  'procedures': {
    public: [
      `Consignes de poste validées conjointement et mises à jour annuellement`,
      `Procédures d'urgence conformes au plan de sécurité de l'établissement (PPMS, POI)`,
      `Exercices d'évacuation et de mise en sûreté selon calendrier de l'acheteur`,
    ],
    prive: [
      `Procédures adaptées aux risques spécifiques du secteur (vol, intrusion, incendie, social)`,
      `Plan de continuité d'activité (PCA) intégré à celui du client`,
    ],
    common: [
      `Procédures opérationnelles : accueil, filtrage, ronde, incident, alarme, évacuation`,
      `Fiche réflexe par type d'événement (intrusion, incendie, accident, personne suspecte)`,
      `Mise à jour continue des procédures selon retours d'expérience`,
    ],
  },
  'amelioration': {
    public: [
      `Bilan annuel de prestation avec analyse des écarts et plan d'amélioration`,
      `Propositions d'optimisation formalisées à chaque reconduction du marché`,
    ],
    prive: [
      `Revue de performance trimestrielle avec propositions d'optimisation`,
      `Benchmark sectoriel et veille technologique au service du client`,
    ],
    common: [
      `Démarche d'amélioration continue (PDCA) intégrée au management GSS`,
      `Analyse des incidents avec actions correctives et préventives tracées`,
      `Veille réglementaire permanente (évolutions CNAPS, normes APSAD, droit du travail)`,
    ],
  },
};

// ─── Helpers stratégiques (type de marché, secteur, contexte réglementaire) ───

/** Détecte si le marché est public ou privé d'après les données d'analyse du DCE. */
function detectMarketType(analysisData: any): 'public' | 'prive' {
  if (!analysisData) return 'public'; // défaut conservateur (plus exigeant)
  const haystack = JSON.stringify(analysisData).toLowerCase();
  const publicIndicators = [
    'marche public', 'marché public', 'commande publique', 'code de la commande',
    'ccag', 'pouvoir adjudicateur', 'collectivite', 'collectivité',
    'universite', 'université', 'etablissement public', 'établissement public',
    'commune ', 'mairie', 'departement', 'département', 'region ', 'région ',
    'ministere', 'ministère', 'etat', 'état', 'hopital', 'hôpital', 'chu ',
    'prefecture', 'préfecture', 'tribunal', 'conseil general', 'conseil général',
    'conseil regional', 'conseil régional', 'communaute', 'communauté',
    'syndicat mixte', 'office public', 'opac', 'oph', 'epci', 'sivom', 'sivu',
    'dc1', 'dc2', 'noti1', 'noti2', 'dume', 'ae ', 'acte engagement',
    'reglement de consultation', 'règlement de consultation',
    'critere d\'attribution', 'critère d\'attribution',
    'offre economiquement', 'offre économiquement',
    'bulletin officiel des annonces', 'boamp', 'joue', 'ted ',
    'procedure ouverte', 'procédure ouverte', 'procedure restreinte', 'procédure restreinte',
    'accord-cadre', 'accord cadre', 'marche a procedure', 'marché à procédure',
  ];
  const privateIndicators = [
    'appel d\'offres prive', 'appel d\'offres privé', 'consultation privee', 'consultation privée',
    'societe ', 'société ', 'entreprise privee', 'entreprise privée',
    'groupe ', 'holding', 'filiale', 'sas ', 'sarl ', 'sa ', 'sasu ',
    'contrat de prestations', 'cahier des charges', 'rfp', 'rfi',
  ];

  let publicScore = 0, privateScore = 0;
  for (const p of publicIndicators) if (haystack.includes(p)) publicScore++;
  for (const p of privateIndicators) if (haystack.includes(p)) privateScore++;

  return publicScore >= privateScore ? 'public' : 'prive';
}

/** Détecte le secteur d'activité du client d'après les données d'analyse. */
function detectClientSector(analysisData: any): string {
  if (!analysisData) return 'tertiaire';
  const haystack = JSON.stringify(analysisData).toLowerCase();
  const sectors: Array<{ name: string; keywords: string[] }> = [
    { name: 'éducation / enseignement supérieur', keywords: ['universite', 'université', 'campus', 'faculte', 'faculté', 'ecole', 'école', 'lycee', 'lycée', 'college', 'collège', 'crous', 'rectorat', 'enseignement'] },
    { name: 'santé / hospitalier', keywords: ['hopital', 'hôpital', 'chu', 'clinique', 'ehpad', 'centre hospitalier', 'ars ', 'sante', 'santé', 'medico', 'médico'] },
    { name: 'industrie / logistique', keywords: ['usine', 'entrepot', 'entrepôt', 'plateforme logistique', 'zone industrielle', 'icpe', 'seveso', 'atex', 'industri'] },
    { name: 'distribution / commerce', keywords: ['centre commercial', 'magasin', 'hypermarche', 'hypermarchée', 'supermarche', 'galerie marchande', 'retail', 'enseigne'] },
    { name: 'événementiel / culture', keywords: ['parc des expositions', 'salle de spectacle', 'musee', 'musée', 'theatre', 'théâtre', 'stade', 'arena', 'festival', 'salon', 'congres', 'congrès', 'foire'] },
    { name: 'transport / infrastructure', keywords: ['gare', 'aeroport', 'aéroport', 'port ', 'tramway', 'metro', 'métro', 'autoroute', 'parking', 'transport'] },
    { name: 'tertiaire / bureaux', keywords: ['siege social', 'siège social', 'immeuble de bureaux', 'tour ', 'campus entreprise', 'coworking', 'tertiaire'] },
    { name: 'collectivité territoriale', keywords: ['mairie', 'hotel de ville', 'hôtel de ville', 'conseil departemental', 'conseil départemental', 'conseil regional', 'conseil régional', 'commune ', 'communaute de communes', 'communauté de communes'] },
    { name: 'résidentiel / habitat social', keywords: ['hlm', 'office public', 'bailleur', 'residence', 'résidence', 'copropriete', 'copropriété', 'habitat social'] },
  ];
  let best = 'tertiaire';
  let bestScore = 0;
  for (const s of sectors) {
    const score = s.keywords.filter(kw => haystack.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = s.name; }
  }
  return best;
}

/** Construit le cadre réglementaire applicable d'après le type de marché et le secteur. */
function buildRegulatoryFramework(marketType: 'public' | 'prive', sector: string, analysisData: any): string {
  const parts: string[] = [];
  // Obligations communes
  parts.push('Livre VI du Code de la sécurité intérieure (activités privées de sécurité)');
  parts.push('Autorisation CNAPS obligatoire (entreprise + dirigeants + agents)');

  if (marketType === 'public') {
    parts.push('Code de la commande publique (ordonnance n°2018-1074 et décret n°2018-1075)');
    parts.push('CCAG-FCS (Cahier des clauses administratives générales — Fournitures courantes et services)');
    parts.push('Obligation de publicité et mise en concurrence');
  } else {
    parts.push('Droit commercial et Code civil (obligations contractuelles)');
    parts.push('Convention collective nationale des entreprises de prévention et de sécurité');
  }

  // Obligations sectorielles
  const haystack = JSON.stringify(analysisData || {}).toLowerCase();
  if (haystack.includes('ssiap') || haystack.includes('incendie')) parts.push('Arrêté du 2 mai 2005 (SSIAP) — qualification incendie');
  if (haystack.includes('apsad') || haystack.includes('telesurveillance') || haystack.includes('télésurveillance')) parts.push('Certification APSAD R31 (télésurveillance)');
  if (haystack.includes('zrr') || haystack.includes('zone a regime restrictif') || haystack.includes('zone à régime restrictif')) parts.push('Habilitation ZRR (Zones à Régime Restrictif)');
  if (haystack.includes('icpe') || haystack.includes('seveso')) parts.push('Réglementation ICPE / Seveso (sites industriels classés)');
  if (haystack.includes('erp') || haystack.includes('etablissement recevant du public') || haystack.includes('établissement recevant du public')) parts.push('Réglementation ERP (sécurité incendie, accessibilité)');
  if (haystack.includes('l1224') || haystack.includes('reprise')) parts.push('Article L1224-1 du Code du travail (reprise du personnel)');

  return parts.join(' ; ');
}

/**
 * Construit le bloc de contexte stratégique à injecter dans les prompts IA pour une section donnée.
 * Sélectionne les solutions GSS pertinentes au type de marché (public/privé) et au thème de la section.
 */
function buildStrategicContext(sectionId: string, analysisData: any): string {
  const marketType = detectMarketType(analysisData);
  const sector = detectClientSector(analysisData);
  const regulatory = buildRegulatoryFramework(marketType, sector, analysisData);

  // Trouver la clé de solution la plus proche du sectionId
  const sectionKey = sectionId.replace(/^b_/, '').replace(/^(i+|iv)_/, '');
  const solutions = GSS_SOLUTIONS_BY_CONTEXT[sectionKey];

  let solutionsBlock = '';
  if (solutions) {
    const relevant = [
      ...solutions.common,
      ...(marketType === 'public' ? solutions.public : solutions.prive),
    ];
    solutionsBlock = relevant.map((s, i) => `${i + 1}. ${s}`).join('\n');
  }

  const parts: string[] = [];
  parts.push(`TYPE DE MARCHÉ : ${marketType === 'public' ? 'Marché public (Code de la commande publique)' : 'Marché privé (contrat de prestations de services)'}`);
  parts.push(`SECTEUR CLIENT : ${sector}`);
  parts.push(`CADRE RÉGLEMENTAIRE : ${regulatory}`);
  if (solutionsBlock) {
    parts.push(`SOLUTIONS GSS DIFFÉRENCIANTES POUR CETTE SECTION :\n${solutionsBlock}`);
  }
  // Problématiques anticipées du DCE
  const issues = analysisData?.anticipatedIssues || [];
  if (issues.length > 0) {
    parts.push(`PROBLÉMATIQUES ANTICIPÉES (non formulées par l'acheteur) :\n${issues.map((i: string, idx: number) => `${idx + 1}. ${i}`).join('\n')}`);
  }
  // Arguments différenciants
  const strengths = analysisData?.proposalStrengths || [];
  if (strengths.length > 0) {
    parts.push(`ARGUMENTS DIFFÉRENCIANTS GSS :\n${strengths.map((s: string, idx: number) => `${idx + 1}. ${s}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

// ─── Stratégie sur-mesure : déclinaison page par page ───

/**
 * « Beats » stratégiques de la synthèse sur-mesure (pages « Contexte sur mesure »), dans l'ordre de
 * lecture. Chaque page reçoit un angle DISTINCT pour raconter une histoire cohérente plutôt que des
 * paragraphes interchangeables. Sont distribués sur le nombre réel de zones via `assignBeats`.
 */
const STRATEGY_BEATS: string[] = [
  "Compréhension du client et de son contexte + enjeux de sûreté propres à son profil (type d'organisation, usagers/parties prenantes, sites, rythme d'exploitation).",
  "Notre stratégie de sûreté pour ce client : les axes différenciants retenus et pourquoi ils répondent précisément à ses enjeux.",
  "Le dispositif au service de la stratégie : moyens humains qualifiés, encadrement et interlocuteur unique, moyens matériels et technologiques adaptés aux sites.",
  "Pilotage, démarche qualité, réactivité et gestion des imprévus, engagement de continuité de service (sans conclusion générique).",
];

/** Assigne un beat à chacune des `n` zones (réutilise/condense la liste si n ≠ STRATEGY_BEATS.length). */
function assignBeats(n: number): string[] {
  if (n <= 0) return [];
  if (n === STRATEGY_BEATS.length) return [...STRATEGY_BEATS];
  // Mappage proportionnel : la zone i prend le beat le plus proche dans la liste de référence.
  return Array.from({ length: n }, (_, i) =>
    STRATEGY_BEATS[Math.min(STRATEGY_BEATS.length - 1, Math.floor((i * STRATEGY_BEATS.length) / n))]);
}

/** Détermine si un spread doit être personnalisé (on garde intactes les pages partenaires/références). */
function shouldPersonalizeSpread(title: string): boolean {
  const n = normTitle(title);
  const skipPatterns = ['confiance', 'partenaire', 'reference client', 'nos clients', 'sommaire', 'table des matieres'];
  return n.length > 0 && !skipPatterns.some(p => n.includes(p));
}

// ─── Field Type Inference ───

function inferFieldHint(context: string): string {
  const n = context.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (/case (a|à) cocher|checkbox/.test(n)) return '[CASE A COCHER]';

  const shortPatterns = [
    'denomination', 'raison sociale', 'nom du candidat', 'nom de l\'entreprise',
    'siret', 'siren', 'cnaps', 'n° ', 'numero', 'reference', 'lot ',
    'adresse', 'code postal', 'ville', 'departement', 'siege', 'agence',
    'telephone', 'tel.', 'fax', 'email', 'mail', 'site web',
    'dirigeant', 'contact', 'interlocuteur', 'responsable', 'signataire',
    'statut', 'pme', 'forme juridique', 'capital social',
    'effectif', 'etp', 'nb agent', "nombre d'agent", 'nombre agents',
    'date ', 'annee', 'duree', 'delai',
    'montant', "chiffre d'affaire", 'ca ', 'code naf', 'code ape',
    'agrement', 'autorisation', 'station', 'siege social',
    // Cellules de tableau numériques (délais d'intervention par site, nb d'intervenants)
    'minute', 'intervenant', 'nombre d\'intervenant', 'taux de reprise', 'numero de certification',
  ];
  if (shortPatterns.some(p => n.includes(p))) return '[VALEUR COURTE]';

  const listPatterns = [
    'certification', 'diplome', 'qualification', 'habilitation',
    'materiel', 'equipement', 'tenue', 'vestiaire',
    'partenaire', 'reference client', 'sous-traitant',
    'logiciel', 'outil', 'systeme', 'moyen technique',
  ];
  if (listPatterns.some(p => n.includes(p))) return '[LISTE]';

  const paraPatterns = [
    'methodologie', 'methode', 'organisation', 'procedure',
    'description', 'presentation', 'demarche', 'engagement',
    'politique', 'gestion', 'management', 'encadrement',
    'suivi', 'controle qualite', 'surveillance', 'securite',
    'recrutement', 'integration', 'planning', 'remplacement',
    'absence', 'retard', 'amelioration', 'bilan', 'rapport',
    'intervention', 'alarme', 'incident', 'intrusion',
    'ecologique', 'environnement', 'developpement durable',
    'valeur', 'ethique', 'rse', 'formation continue',
  ];
  if (paraPatterns.some(p => n.includes(p))) return '[PARAGRAPHE]';

  return '[VALEUR COURTE]';
}

// ─── Main Class ───

export class MemoireGenerator {
  private openai: OpenAI;
  private responseDir: string;
  private templateDir: string;

  constructor() {
    const settings = getSettings();
    this.openai = new OpenAI({ apiKey: settings.openaiApiKey });
    const baseDir = path.resolve(__dirname, '../../../../');
    this.responseDir = path.resolve(baseDir, 'response');
    this.templateDir = path.resolve(baseDir, 'Template');
    if (!fs.existsSync(this.responseDir)) fs.mkdirSync(this.responseDir, { recursive: true });
  }

  private findDceTemplate(dceDir: string): string | null {
    if (!fs.existsSync(dceDir)) return null;
    const files = fs.readdirSync(dceDir);
    const memoireFile = files.find(f => {
      const normalized = f.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      return normalized.includes('memoire') && (normalized.endsWith('.doc') || normalized.endsWith('.docx'));
    });
    return memoireFile ? path.join(dceDir, memoireFile) : null;
  }

  /**
   * Charge les fichiers du DCE (DOC/DOCX/PDF), priorisés par pertinence pour un mémoire technique,
   * puis tronqués pour tenir dans la fenêtre de contexte du modèle (gpt-4o ≈ 128k tokens).
   * Sans ce plafond, le seul CCTP+annexes (~733k caractères) dépasse la limite → l'appel échoue
   * et le document ressort vierge.
   */
  private async getDceContext(dossierId: string): Promise<string> {
    const baseDir = path.resolve(__dirname, '../../../../');
    const settings = getSettings();

    // Budget global et plafond par fichier (en caractères ; ~4 car/token)
    const TOTAL_BUDGET = 240_000;
    const PER_FILE_CAP = 130_000;

    // Score de priorité d'après le nom de fichier (le mémoire porte d'abord sur le CCTP et les effectifs)
    const priorityOf = (n: string): number => {
      if (n.includes('cctp')) return 100;
      if (n.includes('rc ') || n.includes('reglement') || /\brc\b/.test(n)) return 90;
      if (n.includes('annexe 1') || n.includes('effectif') || n.includes('horaire')) return 85;
      if (n.includes('annexe 2') || n.includes('profil')) return 80;
      if (n.includes('ccap') || n.includes('cahier des clauses administ')) return 55;
      if (n.includes('acte') && n.includes('engagement')) return 45;
      if (n.includes('annexe')) return 35;
      return 25;
    };

    type DcePiece = { label: string; text: string; priority: number };
    const pieces: DcePiece[] = [];

    // 1. Sorties JSON pré-analysées (synthèses concises, très utiles) — priorité maximale
    const rcPath = path.join(baseDir, `gss-ao/data/output/rc_${dossierId}.json`);
    const cctpPath = path.join(baseDir, `gss-ao/data/output/cctp_${dossierId}.json`);
    if (fs.existsSync(cctpPath)) pieces.push({ label: 'CCTP (analysé)', text: fs.readFileSync(cctpPath, 'utf8'), priority: 120 });
    if (fs.existsSync(rcPath)) pieces.push({ label: 'RC (analysé)', text: fs.readFileSync(rcPath, 'utf8'), priority: 115 });

    // 2. Fichiers bruts (récursif), dédoublonnés
    const dceDirs = [
      path.resolve(baseDir, `gss-ao/data/output/dce_${dossierId}`),
      settings.corpusDceDir,
      path.resolve(baseDir, 'GSS analyse et génération/DCEDCE MP2026_08'),
      path.resolve(baseDir, 'DCEDCE MP2026_08'),
      path.resolve(baseDir, 'Cas-Univ-Rouen-MP2026-08'),
    ].filter(Boolean) as string[];

    const loadedFiles = new Set<string>();
    const scanDir = async (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { await scanDir(fullPath); continue; }

        const normalized = entry.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.doc', '.docx', '.pdf'].includes(ext)) continue;
        if (normalized.includes('bpu') || normalized.includes('dpgf')) continue;
        if (normalized.includes('memoire') && (normalized.includes('technique') || normalized.includes('gss'))) continue;
        if (loadedFiles.has(normalized)) continue;
        loadedFiles.add(normalized);

        let text = '';
        try {
          text = await extractText(fullPath);
        } catch (e: any) {
          console.warn(`[MemoireGenerator] Impossible de lire: ${entry.name} — ${e.message}`);
          continue;
        }
        if (text.length > 100) {
          pieces.push({ label: entry.name.replace(/\.(doc|docx|pdf)$/i, ''), text, priority: priorityOf(normalized) });
          console.log(`[MemoireGenerator] DCE chargé: ${entry.name} (${text.length} chars, prio ${priorityOf(normalized)})`);
        }
      }
    };
    for (const dceDir of dceDirs) await scanDir(dceDir);

    if (pieces.length === 0) {
      throw new Error('[MemoireGenerator] Aucun contenu DCE trouvé. Vérifiez que les fichiers du DCE sont bien présents.');
    }

    // 3. Assemblage par priorité décroissante, dans le budget total
    pieces.sort((a, b) => b.priority - a.priority);
    let context = '';
    let used = 0;
    for (const p of pieces) {
      if (used >= TOTAL_BUDGET) {
        console.log(`[MemoireGenerator] DCE budget atteint — fichier ignoré: ${p.label}`);
        continue;
      }
      const remaining = TOTAL_BUDGET - used;
      let body = p.text;
      const cap = Math.min(PER_FILE_CAP, remaining);
      if (body.length > cap) body = body.slice(0, cap) + `\n[… document tronqué (${p.text.length - cap} caractères omis) …]`;
      const block = `\n\n--- ${p.label} ---\n${body}`;
      context += block;
      used += block.length;
    }

    console.log(`[MemoireGenerator] Contexte DCE assemblé: ${context.length} chars (budget ${TOTAL_BUDGET}), ${pieces.length} fichiers candidats`);
    return context;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Appel gpt-4o avec retry/backoff sur 429 (la limite TPM du compte oblige à espacer les requêtes).
   * Renvoie le contenu texte, ou null si échec définitif.
   */
  private async callOpenAI(messages: any[], temperature: number, label: string, jsonMode: boolean): Promise<string | null> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const completion = await this.openai.chat.completions.create({
          model: MEMOIRE_MODEL,
          ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
          messages,
          temperature,
        });
        return completion.choices[0].message.content || '';
      } catch (e: any) {
        const status = e?.status || e?.code || '';
        const msg = (e?.message || String(e)).toString();
        if (status === 429 && attempt < maxAttempts) {
          const wait = 15000 * attempt; // 15s, 30s, 45s, 60s
          console.warn(`[MemoireGenerator] ${label}: 429 (TPM) — attente ${wait / 1000}s puis réessai (${attempt}/${maxAttempts - 1})`);
          await this.sleep(wait);
          continue;
        }
        console.error(`[MemoireGenerator] ${label}: appel API échoué (status=${status}): ${msg.slice(0, 240)}`);
        return null;
      }
    }
    return null;
  }

  // ─── Recherche sémantique (embeddings) : index Doc GSS + DCE, récupération par champ ───

  /**
   * Découpe la Documentation GSS (par catégorie) et le DCE (par pièce) en chunks indexables.
   * Le DCE est assemblé en blocs « \n\n--- label ---\n<corps> » (cf. getDceContext) : on le
   * redécoupe sur ces frontières pour étiqueter chaque chunk (CCTP, RC, annexe…).
   */
  private buildRetrievalChunks(gssDocs: Record<string, string>, dceContext: string): RetrievalChunk[] {
    const chunks: RetrievalChunk[] = [];
    const CHUNK = 1200, STEP = 1050;   // ~300 tokens/chunk, léger chevauchement
    const pushChunks = (source: 'GSS' | 'DCE', label: string, text: string) => {
      const clean = (text || '').replace(/\r\n/g, '\n');
      for (let i = 0; i < clean.length; i += STEP) {
        const slice = clean.slice(i, i + CHUNK);
        if (slice.trim().length < 80) continue;
        chunks.push({ source, label, text: slice });
      }
    };
    for (const [cat, text] of Object.entries(gssDocs)) pushChunks('GSS', cat, text);
    const re = /\n\n--- (.+?) ---\n/g;
    let m: RegExpExecArray | null, lastIdx = 0, lastLabel = 'DCE';
    while ((m = re.exec(dceContext)) !== null) {
      if (m.index > lastIdx) pushChunks('DCE', lastLabel, dceContext.slice(lastIdx, m.index));
      lastLabel = m[1]; lastIdx = re.lastIndex;
    }
    pushChunks('DCE', lastLabel, dceContext.slice(lastIdx));
    return chunks;
  }

  /** Embeddings OpenAI par lots (retry/backoff sur 429). Renvoie un vecteur par texte d'entrée. */
  private async embedTexts(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const BATCH = 96;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(t => (t && t.trim() ? t.slice(0, 8000) : ' '));
      for (let attempt = 1; ; attempt++) {
        try {
          const resp = await this.openai.embeddings.create({ model: EMBED_MODEL, input: batch });
          for (const d of resp.data) out.push(d.embedding as number[]);
          break;
        } catch (e: any) {
          const status = e?.status || e?.code || '';
          if (status === 429 && attempt < 5) {
            const wait = 10000 * attempt;
            console.warn(`[MemoireGenerator] Embeddings: 429 (TPM) — attente ${wait / 1000}s puis réessai (${attempt}/4)`);
            await this.sleep(wait);
            continue;
          }
          throw e;
        }
      }
    }
    return out;
  }

  /** Calcule et stocke l'embedding de chaque chunk de l'index. */
  private async embedChunks(chunks: RetrievalChunk[]): Promise<void> {
    const embs = await this.embedTexts(chunks.map(c => c.text));
    chunks.forEach((c, i) => { c.embedding = embs[i]; });
  }

  /** Top-K chunks les plus proches d'un embedding de requête (similarité cosinus). */
  private retrieve(queryEmb: number[], chunks: RetrievalChunk[], k: number): RetrievalChunk[] {
    return chunks
      .filter(c => c.embedding && c.embedding.length > 0)
      .map(c => ({ c, score: cosine(queryEmb, c.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(x => x.c);
  }

  /**
   * Requête de recherche d'un champ. La QUESTION propre du champ est le signal PRINCIPAL : on
   * l'accentue (doublée) et on ÉCARTE le « Contexte proche » (= libellés des champs VOISINS), qui
   * faisait dériver la recherche/réponse vers un sujet adjacent (ex. moyens d'accès au lieu du
   * report des alarmes). À défaut de question (cellule de tableau), on prend l'intitulé Tableau.
   */
  private buildFieldQuery(f: { context: string }): string {
    const grab = (re: RegExp) => (f.context.match(re) || [])[1] || '';
    const question = grab(/Question:\s*"([^"]*)"/);
    const section = grab(/Section:\s*"([^"]*)"/);
    const table = grab(/Tableau:\s*([^|]*)/);
    const core = (question || table).replace(/\[CHAMP_\d+\]/g, '').trim();
    const base = core
      ? `${core} ${core} ${section}`
      : f.context.replace(/\[CHAMP_\d+\]/g, '').replace(/Contexte(?: proche)?:[^|]*/gi, ' ');
    return base.replace(/["|]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * Phase d'ANALYSE structurée (inspirée de l'app de référence gss-app, personas Sacha / Mme Vaché).
   * À partir du DCE (CCTP, RC, rapport de visite terrain, annexes), produit un JSON `analysisData`
   * compact et exploitable, qui sert ensuite de contexte unique au remplissage (au lieu du DCE brut).
   * En plus des faits, le modèle propose des arguments différenciants et des problématiques
   * anticipées — ce qui fait gagner un appel d'offres.
   */
  private async analyzeDce(dceContext: string): Promise<any> {
    const systemPrompt = `Tu es un expert en marchés publics de sécurité privée pour l'entreprise GSS (Global Security Service, ex-GIS).
Ton process s'appuie sur deux rôles : Sacha (amont : analyse du DCE, vérification de l'obligation de visite, comptes-rendus de visite terrain — 60% contiennent des contraintes du terrain absentes du CCTP) et Mme Vaché (rédaction du mémoire technique avec une personnalisation forte : anticiper des problématiques opérationnelles non formulées par l'acheteur).

Ta mission : analyser le CCTP, le RC, le rapport de visite terrain et les annexes pour en extraire, de façon structurée et exhaustive :
1. Le donneur d'ordre, la durée du marché, les sites concernés.
2. Le TYPE DE MARCHÉ : "public" (collectivité, université, hôpital, établissement public, CCAG, code de la commande publique) ou "privé" (entreprise, SAS, SARL, contrat de prestations) — IMPORTANT pour adapter le ton et les obligations légales.
3. Le SECTEUR D'ACTIVITÉ du client (éducation, santé, industrie, distribution, événementiel, tertiaire, collectivité territoriale, etc.).
4. Les besoins en agents (effectifs en ETP, profils : CQP APS, SSIAP 1/2/3, encadrement) et le taux de reprise du personnel en place (annexes).
5. Les contraintes matérielles (contrôle de rondes, pointeaux, PTI/DATI, tenues, véhicules).
6. L'obligation de visite (RC) croisée avec le rapport de visite.
7. Des "Arguments Différenciants" (forces de GSS) et des "Problématiques Anticipées" (risques techniques/humains non formulés par l'acheteur + la solution GSS associée).
8. Des "Recommandations stratégiques GSS" : pour chaque grand thème du mémoire (présentation, moyens humains, moyens opérationnels, moyens organisationnels), propose 2 à 3 arguments SPÉCIFIQUES à ce client que GSS devrait mettre en avant, en tenant compte du cadre public/privé.

Tu renvoies un objet JSON valide et exhaustif.`;

    const userPrompt = `Voici les documents du DCE (CCTP, RC, rapport de visite, annexes) :
${dceContext.slice(0, 120_000)}

Génère une réponse JSON valide respectant EXACTEMENT cette structure :
{
  "clientName": "Nom exact du donneur d'ordre (ex: Université de Rouen Normandie)",
  "projectTitle": "Intitulé complet du marché",
  "marketRef": "Référence du marché (ex: MP n°2026-08)",
  "marketType": "public ou privé — déterminé d'après le DCE (CCAG, commande publique, collectivité → public ; SAS/SARL, contrat privé → privé)",
  "clientSector": "Secteur d'activité du client (éducation, santé, industrie, distribution, événementiel, tertiaire, collectivité, résidentiel…)",
  "duration": "Durée exacte (ex: 1 an renouvelable 3 fois)",
  "lots": [ { "num": "1", "perimetre": "..." } ],
  "visitMandatory": true,
  "visitDetails": "Observations clés du terrain (rapport de visite). Vide si absent.",
  "sites": [ { "name": "Nom exact du site/campus", "requirements": "Effectifs ETP et qualifications" } ],
  "operationalSummary": {
    "agentProfiles": "Profils requis, taux de reprise du personnel, encadrement",
    "uniforms": "Tenues/équipements spécifiques",
    "equipment": "Rondes, pointeaux par site, PTI, véhicules",
    "qualityControls": "Contrôles inopinés, réunions de suivi, extranet"
  },
  "telesurveillance": "Lot 3 : délais d'intervention max par site, nb d'intervenants, certifications APSAD demandées (vide si non concerné)",
  "legalRequirements": "Exigences d'autorisation (CNAPS, agréments dirigeants, agrément établissement local)",
  "keyRisks": [ "Risque/contrainte opérationnelle identifié" ],
  "proposalStrengths": [ "Argument différenciant technique de GSS pour ce marché" ],
  "anticipatedIssues": [ "Problématique non formulée par l'acheteur + solution concrète GSS" ],
  "gssStrategicRecommendations": {
    "presentation": "2-3 arguments spécifiques pour la présentation de GSS adaptés à CE client et CE cadre (public/privé)",
    "moyensHumains": "2-3 arguments spécifiques sur les moyens humains adaptés aux besoins du client",
    "moyensOperationnels": "2-3 arguments spécifiques sur les moyens opérationnels adaptés au secteur/sites",
    "moyensOrganisationnels": "2-3 arguments spécifiques sur l'organisation adaptés au cadre contractuel (public/privé)"
  }
}`;

    const content = await this.callOpenAI(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      0.2, 'Analyse DCE', true,
    );
    try {
      const data = JSON.parse(content || '{}');
      // Post-traitement : enrichir / valider les champs stratégiques via détection locale
      // (le modèle peut se tromper sur public/privé ; la détection par mots-clés est plus fiable)
      const detectedType = detectMarketType(data);
      const detectedSector = detectClientSector(data);
      data.marketType = data.marketType || detectedType;
      data.clientSector = data.clientSector || detectedSector;
      data.regulatoryFramework = buildRegulatoryFramework(
        data.marketType === 'privé' || data.marketType === 'prive' ? 'prive' : 'public',
        data.clientSector,
        data,
      );
      console.log(`[MemoireGenerator] Analyse DCE: client="${data.clientName || '?'}", type=${data.marketType}, secteur="${data.clientSector}", ${(data.sites || []).length} site(s), ${(data.anticipatedIssues || []).length} problématique(s) anticipée(s), cadre réglementaire: ${(data.regulatoryFramework || '').slice(0, 80)}…`);
      return data;
    } catch (e) {
      console.error('[MemoireGenerator] Analyse DCE: parse JSON échoué, repli sur extrait brut.');
      return { rawExcerpt: dceContext.slice(0, 20_000) };
    }
  }

  /**
   * Personnalise le texte statique du maître AO RNE.docx (rédigé pour le marché « Parc des
   * Expositions de Rouen ») en remplaçant SON nom de client par celui du DCE. Le nom figure sur
   * la couverture / le sommaire et est découpé en plusieurs runs (« PARC » / « DES » /
   * « EXPOSITIONS DE ROUEN ») : on travaille donc au niveau du paragraphe (texte concaténé),
   * puis on réinjecte le résultat dans le 1er run (les autres sont vidés). On NE touche PAS au
   * « Rouen » isolé (villes d'agence GSS et références clients « ILS NOUS ONT FAIT CONFIANCE »
   * = preuves sociales à conserver) ni à l'identité GSS.
   */
  private adaptStaticText(xmlDoc: any, analysisData: any) {
    const clientName: string = (analysisData?.clientName || '').trim();
    if (!clientName) return;

    // Phrases complètes du client du maître uniquement (jamais le « Rouen » nu).
    const OLD_CLIENT =
      /PARC\s+DES\s+EXPOSITIONS\s+DE\s+ROUEN|Parc\s+des\s+[Ee]xpositions\s+de\s+Rouen|Parc\s+des\s+[Ee]xpositions|Parc\s+Expo/g;
    const replaceClient = (s: string) =>
      s.replace(OLD_CLIENT, (m) => (m === m.toUpperCase() ? clientName.toUpperCase() : clientName));

    let count = 0;
    getElementsWithLocalName(xmlDoc, 'p').forEach((p: any) => {
      const tEls = getElementsWithLocalName(p, 't');
      if (tEls.length === 0) return;
      const concat = tEls.map((t: any) => t.textContent || '').join('');
      if (!OLD_CLIENT.test(concat)) return;
      OLD_CLIENT.lastIndex = 0; // regex globale → réinitialiser après .test()
      const replaced = replaceClient(concat);
      if (replaced === concat) return;
      tEls[0].textContent = replaced;          // tout le texte dans le 1er run (style du titre conservé)
      for (let i = 1; i < tEls.length; i++) tEls[i].textContent = '';
      count++;
    });
    console.log(`[MemoireGenerator] Personnalisation client: ${count} paragraphe(s) mis à jour → "${clientName}".`);
  }

  public async generate(dossierId: string): Promise<{ filePath: string, generatedData: Record<string, string> }> {
    const settings = getSettings();
    const baseDir = path.resolve(__dirname, '../../../../');
    const uploadedDceDir = path.resolve(baseDir, `gss-ao/data/output/dce_${dossierId}`);

    // 1. Find template. isClientTemplate=true → cadre imposé par l'acheteur (on remplit tel quel).
    // isClientTemplate=false → mémoire GSS maître réutilisé (on adapte d'abord client/sites).
    let templatePath: string | null = null;
    let isClientTemplate = true;

    const possibleDirs = [
      uploadedDceDir,
      settings.corpusDceDir,
      path.resolve(baseDir, 'GSS analyse et génération/DCEDCE MP2026_08'),
      path.resolve(baseDir, 'DCEDCE MP2026_08'),
      path.resolve(baseDir, 'Cas-Univ-Rouen-MP2026-08'),
    ];

    const dossier = DB.getDossier(dossierId);
    if (dossier && dossier.dce_files) {
      const templateFile = dossier.dce_files.find((f: any) => f.type === 'Mémoire (cadre)');
      if (templateFile && templateFile.nom) {
        const filename = path.basename(templateFile.nom);
        for (const dir of possibleDirs) {
          if (!dir) continue;
          const p = path.join(dir, filename);
          if (fs.existsSync(p)) { templatePath = p; break; }
        }
      }
    }

    if (!templatePath) {
      for (const dir of possibleDirs) {
        if (!dir) continue;
        const found = this.findDceTemplate(dir);
        if (found) { templatePath = found; break; }
      }
    }

    if (!templatePath) {
      templatePath = path.join(this.templateDir, 'Mémoire technique', 'AO RNE.docx');
      isClientTemplate = false; // mémoire GSS maître, pas un cadre acheteur
      if (!fs.existsSync(templatePath)) {
        throw new Error(`Aucun template trouvé ni dans le DCE ni dans ${templatePath}`);
      }
    }

    console.log(`[MemoireGenerator] Using template: ${templatePath} (${isClientTemplate ? 'cadre client' : 'mémoire GSS maître'})`);

    // ── Sans cadre imposé : synthèse IA superposée sur AO RNE.pdf (overlay, design figé) ──
    if (!isClientTemplate) {
      return this.generateSynthesisPdf(dossierId);
    }

    // 2. Analyse structurée du DCE (contexte unique de rédaction), avant toute manipulation du Word
    const dceContext = await this.getDceContext(dossierId);
    const analysisData = await this.analyzeDce(dceContext);
    const analysisJson = JSON.stringify(analysisData, null, 2);

    // 2 bis. Connaissances GSS pour répondre au cadre client : on explore TOUS les sous-dossiers de
    // la Documentation GSS (moyens, procédures, organisation…) + le dossier « Personnes » (référents).
    // Le DCE reste le contexte primaire (les exigences) ; la Documentation GSS fournit la matière
    // pour y répondre. Toute info absente de ces sources → champ laissé « [À COMPLÉTER] ».
    const gssDocs = await this.getGssDocumentation();
    const gssDocContext = this.buildFullGssContext(gssDocs);
    const referentsContext = await this.getGssReferents();
    console.log(`[MemoireGenerator] Contexte cadre client: ${Object.keys(gssDocs).length} catégorie(s) Doc GSS (${gssDocContext.length} chars) + référents (${referentsContext.length} chars).`);

    // 3. Load DOCX and parse XML DOM
    const content = fs.readFileSync(templatePath);
    const zip = new PizZip(content);
    const documentXml = zip.file('word/document.xml');
    if (!documentXml) throw new Error('word/document.xml introuvable dans le template');

    const docXmlStr = documentXml.asText();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(docXmlStr, 'text/xml');

    // Si c'est un mémoire GSS maître (et non un cadre acheteur), on adapte d'abord les textes
    // statiques (ancien client / référence marché / noms de sites) au nouveau marché.
    if (!isClientTemplate) {
      this.adaptStaticText(xmlDoc, analysisData);
      const hfSerializer = new XMLSerializer();
      Object.keys(zip.files).forEach(name => {
        if (name.startsWith('word/header') || name.startsWith('word/footer')) {
          const fd = zip.file(name);
          if (!fd) return;
          const hfDoc = parser.parseFromString(fd.asText(), 'text/xml');
          this.adaptStaticText(hfDoc, analysisData);
          zip.file(name, hfSerializer.serializeToString(hfDoc));
        }
      });
    }

    // 3. Walk the DOM to detect fillable fields
    const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    // Seuil ≥5 : les vraies lignes à remplir du formulaire sont longues. Un trait d'union isolé
    // ("sous-traitance") ou des points de suspension "..." en pleine phrase ne comptent PAS.
    const DOT_RUN = /(?:[_.\-…]\s*){5,}/;
    const DOT_RUN_G = /(?:[_.\-…]\s*){5,}/g;
    const isDottedOnly = (s: string) => s.trim().length >= 5 && /^[_.\-…\s]+$/.test(s);
    const hasDottedRun = (s: string) => DOT_RUN.test(s);
    const stripDots = (s: string) => s.replace(DOT_RUN_G, ' ').trim();
    const normCtx = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const isIdentityCtx = (ctx: string) =>
      /adresse|denomination|raison sociale|candidat|cnaps|siret|siren|agrement|certification|station|\bdate\b|n°|numero|delai|minute|intervenant|taux|effectif|\betp\b|telephone|email|mail|coordonnees/.test(normCtx(ctx));

    interface FieldDesc {
      id: number;
      type: 'text' | 'legacy_checkbox' | 'sym_checkbox' | 'w14_checkbox';
      element?: any;
      context: string;
      kind: 'answer' | 'table' | 'checkbox';
      lineCount?: number;
    }

    let fieldCounter = 1;
    const descriptors: FieldDesc[] = [];
    const filledCells = new Set<any>();
    let currentHeading = 'Introduction / Généralités';
    const recentParagraphs: string[] = [];
    let lastQuestionText = '';          // dernier paragraphe-question purement textuel
    let openAnswerField: FieldDesc | null = null; // zone de réponse en cours de coalescence

    const addField = (f: Omit<FieldDesc, 'id'>): FieldDesc => {
      const fd: FieldDesc = { id: fieldCounter++, ...f };
      descriptors.push(fd);
      return fd;
    };

    /** Pose [CHAMP_id] dans le 1er run pointillé (id != null) puis vide les autres runs pointillés. */
    const placeOrClearDotted = (pNode: any, placeId: number | null) => {
      let placed = false;
      getElementsWithLocalName(pNode, 't').forEach((tEl: any) => {
        const text = tEl.textContent || '';
        if (!isDottedOnly(text) && !hasDottedRun(text)) return;
        if (placeId !== null && !placed) {
          tEl.textContent = isDottedOnly(text)
            ? `[CHAMP_${placeId}]`
            : text.replace(DOT_RUN, `[CHAMP_${placeId}]`).replace(DOT_RUN_G, '');
          placed = true;
        } else {
          tEl.textContent = isDottedOnly(text) ? '' : text.replace(DOT_RUN_G, '');
        }
      });
      return placed;
    };

    const walkDOM = (node: any, inDrawing: boolean) => {
      if (node.nodeType !== 1) return;
      const localName = node.localName;
      // Ne pas détecter de champs dans les cartouches graphiques / zones de texte (titre)
      const nowInDrawing = inDrawing || localName === 'drawing' || localName === 'pict' || localName === 'txbxContent';

      if (!nowInDrawing) {
        // ── Suivi des titres / questions (paragraphes purement textuels) ──
        if (localName === 'p') {
          const pText = getElementText(node).trim();
          if (isHeadingParagraph(node)) {
            currentHeading = pText;
            recentParagraphs.length = 0;
            lastQuestionText = '';
            openAnswerField = null;
          } else if (pText && !isDottedOnly(pText) && !hasDottedRun(pText)) {
            // paragraphe purement textuel → libellé/question, ferme toute zone ouverte
            const cleaned = pText.replace(/\[CHAMP_\d+\]/g, '').trim();
            if (cleaned) {
              recentParagraphs.push(cleaned);
              if (recentParagraphs.length > 3) recentParagraphs.shift();
              if (cleaned.length < 300) lastQuestionText = cleaned;
              openAnswerField = null;
            }
          }
        }

        // ── A. Cellules de tableau : cellules vides dans une ligne à contenu mixte ──
        if (localName === 'tr') {
          openAnswerField = null;
          const directCells = getDirectCells(node);
          const cellInfos = directCells.map((cell: any) => ({ cell, isEmpty: getElementText(cell).trim() === '' }));
          const hasText = cellInfos.some((c: any) => !c.isEmpty);
          const hasEmpty = cellInfos.some((c: any) => c.isEmpty);
          if (hasText && hasEmpty) {
            cellInfos.forEach((cInfo: any, cellIdx: number) => {
              // La 1re cellule d'une ligne est la colonne LIBELLÉ (intitulé de la ligne) : on ne la
              // remplit jamais, même vide, pour ne pas écraser/inventer un en-tête de ligne.
              if (cellIdx === 0) return;
              if (cInfo.isEmpty && !filledCells.has(cInfo.cell)) {
                filledCells.add(cInfo.cell);
                const cellContext = getTableCellContext(cInfo.cell, node);
                const nearbyCtx = recentParagraphs.length > 0 ? ` | Contexte proche: "${recentParagraphs.slice(-2).join(' / ')}"` : '';
                const fd = addField({ type: 'text', kind: 'table', context: `Section: "${currentHeading}" | Tableau: ${cellContext}${nearbyCtx}` });
                let p = findLocalNameChild(cInfo.cell, 'p') || getElementsWithLocalName(cInfo.cell, 'p')[0];
                if (!p) { p = xmlDoc.createElementNS(WNS, 'w:p'); cInfo.cell.appendChild(p); }
                const r = xmlDoc.createElementNS(WNS, 'w:r');
                const t = xmlDoc.createElementNS(WNS, 'w:t');
                t.textContent = `[CHAMP_${fd.id}]`;
                r.appendChild(t); p.appendChild(r);
              }
            });
          }
        }

        // ── B. Paragraphes ──
        if (localName === 'p') {
          const parentCell = getParentWithLocalName(node, 'tc');
          if (!(parentCell && filledCells.has(parentCell))) {
            const fullText = getElementText(node).trim();

            // Cases à cocher (legacy / Wingdings / w14 / texte) — détection inchangée
            getElementsWithLocalName(node, 'checkBox').forEach((cb: any) => {
              addField({ type: 'legacy_checkbox', element: cb, kind: 'checkbox', context: `Section: "${currentHeading}" | Case à cocher. Contexte: "${fullText}"` });
            });
            getElementsWithLocalName(node, 'sym').forEach((sym: any) => {
              const font = sym.getAttribute('w:font') || sym.getAttributeNS('*', 'font');
              const char = sym.getAttribute('w:char') || sym.getAttributeNS('*', 'char');
              if (font === 'Wingdings' && (char === 'F0A8' || char === 'F0FE')) {
                addField({ type: 'sym_checkbox', element: sym, kind: 'checkbox', context: `Section: "${currentHeading}" | Case à cocher (symbole). Contexte: "${fullText}"` });
              }
            });
            getElementsWithLocalName(node, 'checkbox').forEach((w14: any) => {
              if (w14.namespaceURI === 'http://schemas.microsoft.com/office/word/2010/wordml' || w14.prefix === 'w14' || w14.localName === 'checkbox') {
                addField({ type: 'w14_checkbox', element: w14, kind: 'checkbox', context: `Section: "${currentHeading}" | Case à cocher (contrôle de contenu). Contexte: "${fullText}"` });
              }
            });
            if (/☐|\[\s*\]|\(\s*\)/.test(fullText)) {
              getElementsWithLocalName(node, 't').forEach((tEl: any) => {
                const text = tEl.textContent || '';
                const regex = /☐|\[\s*\]|\(\s*\)/g;
                let match; let out = text; let replaced = false;
                while ((match = regex.exec(text)) !== null) {
                  const fd = addField({ type: 'text', kind: 'checkbox', context: `Section: "${currentHeading}" | Case à cocher. Contexte: "${fullText}"` });
                  out = out.replace(match[0], `[CHAMP_${fd.id}]`); replaced = true;
                }
                if (replaced) tEl.textContent = out;
              });
            }

            // Zones de réponse : pointillés ou paragraphe vide → coalescence
            const dotted = hasDottedRun(fullText) || getElementsWithLocalName(node, 't').some((t: any) => isDottedOnly(t.textContent || ''));
            if (dotted) {
              const inlineLabel = stripDots(fullText);
              if (openAnswerField && inlineLabel === '') {
                // ligne de pointillés qui prolonge la zone ouverte
                placeOrClearDotted(node, null);
                openAnswerField.lineCount = (openAnswerField.lineCount || 1) + 1;
              } else {
                const ctxLabel = inlineLabel || lastQuestionText || recentParagraphs.slice(-1)[0] || '';
                const nearby = recentParagraphs.length ? ` | Contexte: "${recentParagraphs.slice(-2).join(' / ')}"` : '';
                const fd = addField({ type: 'text', kind: 'answer', lineCount: 1, context: `Section: "${currentHeading}" | Question: "${ctxLabel}"${nearby}` });
                placeOrClearDotted(node, fd.id);
                openAnswerField = fd;
                if (!inlineLabel) lastQuestionText = ''; // question consommée
              }
            } else if (fullText === '') {
              if (openAnswerField) {
                // ligne blanche au sein d'une zone de réponse en cours
                openAnswerField.lineCount = (openAnswerField.lineCount || 1) + 1;
              } else if (lastQuestionText && lastQuestionText.trimEnd().endsWith(':')) {
                // paragraphe vide juste après un libellé "… :"
                const fd = addField({ type: 'text', kind: 'answer', lineCount: 1, context: `Section: "${currentHeading}" | Question: "${lastQuestionText}"` });
                const r = xmlDoc.createElementNS(WNS, 'w:r');
                const t = xmlDoc.createElementNS(WNS, 'w:t');
                t.textContent = `[CHAMP_${fd.id}]`;
                r.appendChild(t); node.appendChild(r);
                openAnswerField = fd;
                lastQuestionText = '';
              }
            }
          }
        }
      }

      // Recurse
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) walkDOM(node.childNodes[i], nowInDrawing);
      }
    };

    walkDOM(xmlDoc.documentElement, false);

    // Construit le libellé de prompt de chaque champ (hint de format + contexte)
    const buildPrompt = (f: FieldDesc): string => {
      // Les mots-codes de champs de formulaire Word ne doivent pas polluer l'inférence ni le prompt
      const cleanCtx = f.context.replace(/FORM(CHECKBOX|TEXT|DROPDOWN)/gi, ' ').replace(/\s{2,}/g, ' ').trim();
      let hint = inferFieldHint(cleanCtx);
      if (f.kind === 'checkbox') hint = '[CASE A COCHER]';
      // Une zone de réponse étalée sur plusieurs lignes appelle un paragraphe développé,
      // sauf s'il s'agit clairement d'un champ d'identité court.
      if (f.kind === 'answer' && (f.lineCount || 1) >= 3 && !isIdentityCtx(cleanCtx)) hint = '[PARAGRAPHE]';
      const extent = f.kind === 'answer' && (f.lineCount || 1) > 1
        ? ` (zone de ${f.lineCount} lignes — réponse développée attendue)` : '';
      return `Champ [CHAMP_${f.id}] ${hint} : ${cleanCtx}${extent}`;
    };
    const prompts: string[] = descriptors.map(buildPrompt);

    console.log(`[MemoireGenerator] Detected ${prompts.length} fillable fields in document.`);
    if (prompts.length === 0) throw new Error("Aucun champ à remplir détecté dans le template Word.");

    const systemPrompt = `Tu es un rédacteur chevronné de mémoires techniques pour l'entreprise GSS (Global Security Service, ex-GIS), expert des marchés publics de sécurité privée.
On te fournit (1) l'ANALYSE stratégique et opérationnelle du marché issue du DCE (client, sites, exigences, rapport de visite de Sacha, arguments différenciants de GSS, problématiques terrain anticipées), (2) la DOCUMENTATION GSS (moyens, procédures, organisation, formations… — connaissances internes), (3) les RÉFÉRENTS GSS (dossier « Personnes ») et (4) une liste de champs [CHAMP_X] repérés dans le cadre de réponse de l'acheteur. Tu rédiges la valeur à insérer dans chacun.

SOURCES À EXPLOITER (impératif) : pour CHAQUE champ, appuie-toi sur le DCE (ce que l'acheteur exige) ET sur la Documentation GSS (ce que GSS sait/fait pour y répondre). Pour un champ demandant un interlocuteur/référent/encadrant/contact, utilise les RÉFÉRENTS GSS (« Personnes »). AVANT de répondre, cherche réellement l'information dans CHAQUE bloc source fourni ci-dessous (EXTRAIT DU DCE PERTINENT, DOCUMENTATION GSS PERTINENTE *et* la liste « Autres catégories Doc GSS », RÉFÉRENTS GSS) : l'information y est souvent enfouie plus loin. N'écris EXACTEMENT "[À COMPLÉTER]" (plutôt que d'inventer) QUE si — et seulement si — après cette recherche l'information n'est présente NI dans le DCE, NI dans la Documentation GSS, NI dans les Référents.

══════════════════════════════════════
RÈGLE N°0 — QUI EST QUI (NE JAMAIS CONFONDRE)
══════════════════════════════════════
- LE CANDIDAT / SOUMISSIONNAIRE / "l'entreprise qui exécutera le marché" = GSS (Global Security Service). C'est TOI.
- L'ACHETEUR / CLIENT = l'organisme qui passe le marché (le clientName de l'analyse). Ce N'EST PAS le candidat.
- "Dénomination du candidat" = "GSS - Global Security Service" (JAMAIS le nom de l'acheteur).

══════════════════════════════════════
RÈGLE N°1 — FORMAT DE RÉPONSE (selon le tag de chaque champ)
══════════════════════════════════════
[VALEUR COURTE]   → 1 à 6 mots, valeur brute factuelle (ex: "93 ETP", "Campus Pasteur", "Oui"). Pas de phrase d'intro.
[LISTE]           → items séparés par "- " et un saut de ligne (ex: "- CQP APS\n- SSIAP 1").
[PARAGRAPHE]      → paragraphe dense, technique et engageant (5 à 9 phrases développées) qui VEND GSS. Jamais de réponse paresseuse ("Conforme", "Disponible", "Oui"), jamais de généralité interchangeable. Chaque paragraphe doit suivre une logique STRATÉGIQUE : (1) nomme l'enjeu/risque PRÉCIS du client (issu de l'analyse, du CCTP ou de la visite terrain), (2) propose la réponse GSS DIFFÉRENCIANTE qui y répond (un moyen, une méthode, un engagement concret — pas un slogan), (3) explicite le BÉNÉFICE mesurable pour le client. Le lecteur doit sentir que GSS a compris SON enjeu, pas récité un argumentaire générique.
[CASE A COCHER]   → UNIQUEMENT "☑" (GSS se conforme à 100%) ou "☐".
JAMAIS de markdown (pas de **gras**, pas de #). Sauts de ligne et tirets simples uniquement.

══════════════════════════════════════
RÈGLE N°2 — PERSONNALISATION (ce qui fait gagner)
══════════════════════════════════════
- Utilise le nom exact du client, des sites et le contexte de l'analyse pour un texte totalement sur-mesure.
- Exploite les observations de la visite terrain (visitDetails) pour prouver notre connaissance du site.
- Intègre les "proposalStrengths" et les "anticipatedIssues" (avec leur solution GSS) au cœur des [PARAGRAPHE], pour montrer que GSS anticipe des risques non formulés dans le CCTP.
- Décris concrètement : organisation, contrôle CNAPS, gestion des plannings, rondes/pointeaux NFC, PTI/DATI, gestion des alarmes, remplacement d'agents.
- VRAI AVANTAGE : ne te contente pas de "nous assurons X" — formule à chaque fois en quoi la manière GSS de faire X est SUPÉRIEURE (délai chiffré, taux de couverture, redondance, anticipation d'un risque que le concurrent ignore) et ce que le client y gagne concrètement.

══════════════════════════════════════
RÈGLE N°3 — DONNÉES LÉGALES : NE JAMAIS INVENTER
══════════════════════════════════════
Pour tout champ d'identité légale (SIRET, N° CNAPS, NOM du dirigeant, n° d'agrément dirigeant, dates
d'obtention/validité, n° de certification, adresses, coordonnées/téléphone/email) ou tout nom de référent :
n'utilise QUE des valeurs présentes dans l'analyse/DCE, la Documentation GSS ou les Référents GSS
(« Personnes »). Sinon écris EXACTEMENT "[À COMPLÉTER]" (rien d'autre, pas de nom inventé type
"Jean Dupont"). N'invente JAMAIS un nom, un numéro, une date, une adresse ou un contact.
ATTENTION SPÉCIFIQUE AUX COORDONNÉES : les RÉFÉRENTS GSS (« Personnes ») ne contiennent QUE des noms
et des rôles — AUCUN téléphone, AUCUN email, AUCUNE adresse. Donc pour tout numéro de téléphone, email
ou adresse postale qui n'est pas EXPLICITEMENT écrit dans les sources : écris "[À COMPLÉTER]". N'invente
JAMAIS "01 23 45 67 89", "prenom.nom@gss.fr" ni une adresse type "123 Rue de la Sécurité, 75000 Paris".
Pour un champ « coordonnées de l'interlocuteur », réponds le nom + rôle réel du référent puis
"[À COMPLÉTER]" pour le téléphone/email (ex : "MARCHANI Adil, Directeur d'agence — tél/email : [À COMPLÉTER]").

══════════════════════════════════════
RÈGLE N°4 — CADRE RÉGLEMENTAIRE ET SOLUTIONS GSS SPÉCIFIQUES
══════════════════════════════════════
${(() => {
  const mt = detectMarketType(analysisData);
  const sec = detectClientSector(analysisData);
  if (mt === 'public') return `Ce marché est un MARCHÉ PUBLIC (secteur : ${sec}).
- Respecte le vocabulaire du Code de la commande publique : pouvoir adjudicateur, acheteur, titulaire, sous-critères.
- Cite les articles pertinents du CCP et du CCAG-FCS quand approprié.
- Mets en avant les garanties de conformité, les mécanismes de contrôle (pénalités contractuelles, réunions périodiques, rapports de suivi formalisés).
- Souligne l'expérience de GSS auprès d'établissements publics similaires.
- Intègre les obligations de transparence (plannings transmis, CVs anonymisés, extranet).`;
  return `Ce marché est un MARCHÉ PRIVÉ (secteur : ${sec}).
- Adopte un ton commercial plus direct et orienté résultats.
- Mets en avant la flexibilité, la réactivité et les SLA sur mesure.
- Souligne l'adaptation aux process internes et à la culture du client.
- Propose des engagements chiffrés (délais de remplacement, taux de couverture, KPIs personnalisés).
- Mentionne la possibilité de co-construction du dispositif avec le client.`;
})()}

FORMAT DE RÉPONSE : JSON valide uniquement → {"replacements": [ {"id": 1, "value": "..."} ]}`;

    // Valeurs renvoyées par l'IA (une par champ [CHAMP_n]).
    const replacements: Array<{ id: number; value: string }> = [];

    /** Exécute des tâches avec une concurrence limitée (protège la limite TPM). */
    const runPool = async (jobs: Array<() => Promise<void>>, limit: number): Promise<void> => {
      let idx = 0;
      const worker = async () => { while (idx < jobs.length) { const j = jobs[idx++]; await j(); } };
      await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    };

    // ── Remplissage QUESTION PAR QUESTION (recherche sémantique + 1 appel IA par champ) ──
    // Chaque champ [CHAMP_n] est traité INDIVIDUELLEMENT : on recherche dans la Documentation GSS
    // et le DCE (index d'embeddings) les passages réellement pertinents pour CE champ, puis on fait
    // UN appel IA dédié pour rédiger sa valeur. Plus de blob générique partagé par 20 champs :
    // chaque réponse est ancrée dans les bonnes sources (« fouiller là où il faut »).
    const retrievalChunks = this.buildRetrievalChunks(gssDocs, dceContext);
    await this.embedChunks(retrievalChunks);
    const gssN = retrievalChunks.filter(c => c.source === 'GSS' && c.embedding).length;
    const dceN = retrievalChunks.filter(c => c.source === 'DCE' && c.embedding).length;
    console.log(`[MemoireGenerator] Index sémantique : ${gssN} chunks Doc GSS + ${dceN} chunks DCE.`);

    // Embeddings de TOUTES les requêtes de champ en un lot → la récupération devient du calcul local.
    const queryEmbs = await this.embedTexts(descriptors.map(d => this.buildFieldQuery(d)));
    const queryEmbById = new Map<number, number[]>();
    descriptors.forEach((d, i) => queryEmbById.set(d.id, queryEmbs[i]));

    const strategicCtx = buildStrategicContext('', analysisData);

    /** Traite UN champ : recherche ciblée des passages pertinents + 1 appel IA dédié. */
    const answerField = async (f: FieldDesc): Promise<void> => {
      const qEmb = queryEmbById.get(f.id);
      const top = qEmb ? this.retrieve(qEmb, retrievalChunks, 8) : [];
      const gssPassages = top.filter(c => c.source === 'GSS');
      const dcePassages = top.filter(c => c.source === 'DCE');
      const fmtBlock = (title: string, cs: RetrievalChunk[]) => cs.length
        ? `\n--- ${title} ---\n` + cs.map((c, i) => `[${c.label} #${i + 1}]\n${c.text}`).join('\n\n') + '\n' : '';
      // Champ qui demande EXPLICITEMENT une personne/contact. On se base sur la QUESTION du champ,
      // pas sur tout le contexte : sinon le simple mot « responsable » d'un titre de section
      // (« Plan qualité interne – responsable qualité ») fait recopier le nom du référent dans TOUS
      // les champs de la section. Les référents ne sont injectés que pour ces champs-là.
      const qMatch = f.context.match(/Question:\s*"([^"]*)"/);
      const fieldAsk = qMatch ? qMatch[1] : f.context;
      // On se base sur la QUESTION PROPRE du champ (pas tout le contexte) : c'est ce qui évite le flood
      // (« VATTIER Marie » recopié partout) tout en injectant le référent là où il est VRAIMENT demandé.
      // Un champ dont la question nomme un RÔLE (responsable qualité, directeur, référent…) ou demande
      // un nom/coordonnées attend une personne → on lui fournit les Référents GSS (« Personnes »). Les
      // champs vagues (question vide « : ») n'ont pas de rôle dans leur question → pas d'injection.
      const isReferent = /\b(nom|noms|coordonn[ée]es|interlocuteur|courriel|r[ée]f[ée]rent|encadrant|dirigeant|directeur|directrice|g[ée]rant|pr[ée]sident|responsable)\b/i.test(fieldAsk);
      const hint = buildPrompt(f);
      const isParagraph = hint.includes('[PARAGRAPHE]');
      // Champ d'IDENTITÉ / LÉGAL / CONTACT : valeur qui ne peut PAS se déduire, elle doit exister
      // telle quelle dans les sources (nom de personne, SIRET/SIREN, CNAPS, agrément, certification,
      // date, adresse, siège, téléphone, email). On y applique la règle stricte « verbatim ou rien ».
      const isStrictId = /siret|siren|\bcnaps\b|agr[ée]ment|autorisation|certification|kbis|\bdate\b|adresse|si[èe]ge|d[ée]nomination|raison sociale|t[ée]l[ée]phone|\btel\b|email|\bmail\b|courriel|coordonn[ée]es/i.test(f.context)
        || isReferent;

      // Consigne adaptée au TYPE de champ — 3 niveaux :
      //  1) [PARAGRAPHE] → argumentaire sur-mesure qui vend GSS (ce qui marche déjà bien) ;
      //  2) champ COURT FACTUEL non-identité (effectif, taux, qualification, conformité, délai…) →
      //     réponse BRÈVE, synthétisée À PARTIR des sources (on autorise le calcul/synthèse) ;
      //  3) champ d'IDENTITÉ/LÉGAL/CONTACT → « verbatim ou [À COMPLÉTER] » : PAS DE DONNÉE INVENTÉE.
      const instruction = isParagraph
        ? `Rédige un paragraphe dense, technique et personnalisé qui répond précisément à l'attente de l'acheteur et met en avant la valeur ajoutée de GSS, en t'appuyant sur les extraits ci-dessus. N'invente aucune donnée factuelle (nom, date, numéro) absente des sources.`
        : isStrictId
          ? `Ce champ attend une donnée d'IDENTITÉ/LÉGALE/CONTACT précise. Donne UNIQUEMENT la valeur — aucune phrase, aucun argumentaire.
RÈGLE ABSOLUE — AUCUNE DONNÉE INVENTÉE : la valeur (nom de personne, date, n° SIRET/SIREN, n° CNAPS, agrément, certification, adresse, téléphone, email) doit figurer EXPLICITEMENT dans les extraits ci-dessus (DCE, Documentation GSS ou Référents). Sinon écris EXACTEMENT "[À COMPLÉTER]" et RIEN d'autre. N'invente JAMAIS, ne déduis JAMAIS et n'utilise JAMAIS d'exemple générique (proscrits : "Jean Dupont", "01/01/2020", "01 23 45 67 89", "prenom.nom@gss.fr", un SIRET au hasard). En cas de doute → "[À COMPLÉTER]".`
          : `Ce champ attend une réponse COURTE et FACTUELLE (quelques mots, une valeur, une liste, ou Oui/Non). Donne UNIQUEMENT la réponse — aucune phrase d'introduction, aucun argumentaire. Appuie-toi sur les extraits ci-dessus : tu peux SYNTHÉTISER ou recouper ce qu'ils contiennent (effectifs/ETP, qualifications requises, taux de reprise, délais, conformité…). N'invente AUCUNE donnée nominative, légale ou chiffrée (nom, date, SIRET, CNAPS, adresse, téléphone, email, montant) absente des sources : dans ce cas écris "[À COMPLÉTER]".`;

      const userPrompt = `Analyse du marché (contexte de rédaction) :
${analysisJson}

--- CONTEXTE STRATÉGIQUE GSS ---
${strategicCtx}
${fmtBlock("EXTRAITS PERTINENTS DU DCE (exigences de l'acheteur)", dcePassages)}${fmtBlock('DOCUMENTATION GSS PERTINENTE (sources internes — appuie ta réponse dessus)', gssPassages)}${isReferent && referentsContext ? `\n--- RÉFÉRENTS GSS (« Personnes ») ---\n${referentsContext}\n` : ''}
CHAMP UNIQUE À RÉDIGER :
${hint}

${instruction}
${fieldAsk && fieldAsk !== f.context ? `IMPORTANT — RESTE STRICTEMENT SUR LE SUJET DE CETTE QUESTION : « ${fieldAsk.trim()} ». N'utilise pas une information hors-sujet des extraits (ne réponds pas sur un thème VOISIN — ex. ne parle pas des moyens d'accès/clés si la question porte sur le report des alarmes). Si aucun extrait ne traite SPÉCIFIQUEMENT cette question, écris "[À COMPLÉTER]".\n` : ''}Renvoie UNIQUEMENT un objet JSON : {"id": ${f.id}, "value": "..."}`;

      const temperature = isParagraph ? 0.4 : isStrictId ? 0.1 : 0.2;
      const label = `Champ ${f.id}`;
      const aiResponse = await this.callOpenAI(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature, label, true,
      );
      if (aiResponse === null) return;
      try {
        const data = JSON.parse(aiResponse || '{}');
        const value = data.value ?? (Array.isArray(data.replacements) ? data.replacements[0]?.value : undefined);
        if (value !== undefined && value !== null) replacements.push({ id: f.id, value: String(value) });
      } catch (e) {
        console.error(`[MemoireGenerator] ${label}: parse JSON échoué:`, (aiResponse || '').slice(0, 160));
      }
    };

    // Concurrence 2 : chaque appel porte l'analyse + extraits ; au-delà on sature la TPM (30k) du compte.
    console.log(`[MemoireGenerator] Rédaction question par question de ${descriptors.length} champs...`);
    await runPool(descriptors.map(d => () => answerField(d)), 2);

    // Passe de complétion : rattrape les champs sans valeur (appel ayant échoué).
    const answeredIds = new Set(replacements.map(r => r.id));
    const missing = descriptors.filter(d => !answeredIds.has(d.id));
    if (missing.length > 0) {
      console.log(`[MemoireGenerator] Passe de complétion : ${missing.length} champ(s) manquant(s).`);
      await runPool(missing.map(d => () => answerField(d)), 2);
    }

    console.log(`[MemoireGenerator] GPT a renvoyé ${replacements.length} valeurs au total.`);

    // ── Garde-fou anti-invention de DONNÉES FACTUELLES (le cœur du « pas de données inventées ») ──
    // Le LLM fabrique volontiers adresses, téléphones, emails, dates, n° SIRET/CNAPS plausibles.
    // On vérifie TOUTE donnée factuelle contre les sources réelles (DCE + Doc GSS + « Personnes ») :
    //  • champ d'IDENTITÉ stricte (SIRET, CNAPS, agrément, date, adresse, certification) → si un
    //    chiffre ou un email n'est pas dans les sources, la valeur entière devient [À COMPLÉTER] ;
    //  • champ de CONTACT (coordonnées, téléphone, email, interlocuteur) → on retire UNIQUEMENT le
    //    téléphone/email inventé (en gardant le nom réel du référent), le reste passe par guardNames.
    const sourceTextNorm = normCtx(analysisJson + ' ' + dceContext + ' ' + gssDocContext + ' ' + referentsContext);
    const sourceDigits = sourceTextNorm.replace(/\D/g, '');
    const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g;
    const PHONE_RE = /\+?\d(?:[\d ().\-]{7,})\d/g;     // n° téléphone (≥9 chiffres espacés/groupés)
    const digitsKnown = (s: string) => { const d = s.replace(/\D/g, ''); return d.length < 3 || sourceDigits.includes(d); };
    const isStrictIdentity = (ctx: string) => /siret|siren|\bcnaps\b|autorisation|agrement|certification|\bdate\b|adresse|siege|kbis/.test(normCtx(ctx));
    const isContactField = (ctx: string) => /coordonnees|telephone|\btel\b|\bemail\b|\bmail\b|courriel|interlocuteur|contact|renseignements/.test(normCtx(ctx));
    const guardFactual = (val: string, ctx: string): string => {
      const nctx = normCtx(ctx);
      // Champ d'identité stricte : toute valeur contenant un chiffre/email non sourcé → [À COMPLÉTER].
      if (isStrictIdentity(nctx)) {
        const emails = val.match(EMAIL_RE) || [];
        const digitRuns = val.match(/\d{3,}/g) || [];
        const invented = emails.some(e => !sourceTextNorm.includes(normCtx(e))) || digitRuns.some(d => !sourceDigits.includes(d));
        if (invented) {
          console.log(`[MemoireGenerator] Garde-fou identité: valeur non sourcée → [À COMPLÉTER] (ctx: ${ctx.slice(0, 60)})`);
          return '[À COMPLÉTER]';
        }
        return val;
      }
      // Champ de contact : on neutralise seulement les téléphones/emails inventés (on garde le nom).
      if (isContactField(nctx)) {
        return val
          .replace(EMAIL_RE, e => sourceTextNorm.includes(normCtx(e)) ? e : '[À COMPLÉTER]')
          .replace(PHONE_RE, p => digitsKnown(p) ? p : '[À COMPLÉTER]');
      }
      return val;
    };

    // Garde-fou anti-invention de NOMS de personnes ("c'est qui Jean Dupont ?") : tout nom propre
    // de personne présent dans une valeur générée mais ABSENT des sources réelles (DCE + Doc GSS +
    // fichier « Personnes ») est remplacé par [À COMPLÉTER]. On ne se fie donc PAS au LLM pour les
    // noms : seuls les référents/contacts effectivement présents dans tes données peuvent ressortir.
    const sourceNamesNorm = sourceTextNorm;
    // Sigles/organisations en capitales : ne JAMAIS traiter comme des personnes (sinon faux positifs).
    const NAME_STOPLIST = new Set(['gss', 'gis', 'cctp', 'ccap', 'ccag', 'fcs', 'cnaps', 'apsad', 'ssiap',
      'cqp', 'aps', 'sst', 'dati', 'pti', 'erp', 'icpe', 'zrr', 'rgpd', 'tva', 'siret', 'siren', 'kbis',
      'place', 'aws', 'dc1', 'dc2', 'noti1', 'noti2', 'pca', 'ppms', 'poi', 'rse', 'iso', 'mac', 'nfc',
      'qr', 'sla', 'kpi', 'etp', 'pc', 'gtc']);
    // Mots-indices d'une personne : permettent de repérer un nom même en casse normale ("Pierre Martin").
    const CUE = `(?:M\\.|Mme|Mr\\.?|Monsieur|Madame|Dr\\.?|interlocuteur|responsable|directeur|directrice|contact|r[ée]f[ée]rent|dirigeant|g[ée]rant|pr[ée]sident|pr[ée]sidente|chef|encadrant|nomm[ée]|assur[ée])`;
    // Un nom = 2 mots Capitalisés (l'un peut être en CAPITALES : convention NOM Prénom).
    const NAME = `[A-ZÀ-Ÿ][\\wÀ-ÿ'’-]+\\s+[A-ZÀ-Ÿ][\\wÀ-ÿ'’-]+`;
    // Détecte un nom SOIT précédé d'un indice (cas casse normale), SOIT en convention CAPITALES/Capitale.
    const PERSON_NAME_RE = new RegExp(
      `(?:${CUE}[\\s,’'-]+)(${NAME})` +                                       // indice + Prénom Nom
      `|\\b([A-ZÀ-Ÿ]{2,}(?:[-'’][A-ZÀ-Ÿ]+)*\\s+[A-ZÀ-Ÿ][a-zà-ÿ][\\wà-ÿ'’-]*)` + // NOM Prénom
      `|\\b([A-ZÀ-Ÿ][a-zà-ÿ][\\wà-ÿ'’-]*\\s+[A-ZÀ-Ÿ]{2,}(?:[-'’][A-ZÀ-Ÿ]+)*)\\b`, // Prénom NOM
      'g');
    /** Vrai si CHAQUE composant du nom (≥3 lettres) est présent dans les sources (ordre indifférent). */
    const nameInSources = (name: string): boolean => {
      const tokens = normCtx(name).split(/[\s,’'-]+/).filter((t) => t.length >= 3 && !NAME_STOPLIST.has(t));
      if (tokens.length === 0) return true;                       // que des sigles/initiales → on laisse
      return tokens.every((t) => sourceNamesNorm.includes(t));
    };
    const guardNames = (val: string): string =>
      val.replace(PERSON_NAME_RE, (full, cued, nomFirst, nomLast) => {
        const name = (cued || nomFirst || nomLast || '').trim();   // partie « nom » réellement capturée
        if (!name || nameInSources(name)) return full;             // nom présent dans tes données → OK
        console.log(`[MemoireGenerator] Garde-fou noms: "${name}" absent des sources → [À COMPLÉTER]`);
        // On ne remplace QUE le nom, en préservant l'éventuel mot-indice qui le précède.
        return full.replace(name, '[À COMPLÉTER]');
      });

    // Garde-fou « placeholders » : (1) normalise un "[À COMPLÉTER]" mal formé (ex. "À COMPLÉTER"
    // sans crochets, renvoyé par le modèle) ; (2) neutralise les EXEMPLES-TYPES que le LLM glisse
    // parfois malgré la consigne — faux noms/dates/numéros que guardNames/guardFactual ne couvrent
    // pas toujours (ex. "Jean Dupont" en Titlecase sans mot-indice). → [À COMPLÉTER].
    // Inclut les exemples factices du CADRE CLIENT lui-même (le template contient des valeurs de
    // démonstration — faux nom, fausse date, faux n° séquentiel — que le modèle recopie comme si
    // elles étaient sourcées, puisqu'elles figurent dans le DCE). On les neutralise explicitement.
    const FAKE_VALUE_RE = /\bjean\s+dupont\b|\bjohn\s+doe\b|prenom\.nom@|\b01\s?23\s?45\s?67\s?89\b|\b01\/01\/2020\b|\b123\s?456\s?789\b|\b987\s?654\s?321\b/gi;
    const guardPlaceholders = (val: string, ctx = ''): string => {
      let v = val.trim();
      if (!v) return '';   // valeur volontairement vidée (ligne parasite) → reste VIDE, pas « [À COMPLÉTER] »
      if (/^\[?\s*[àa]\s*compl[ée]ter\s*\]?\.?$/i.test(v)) return '[À COMPLÉTER]';
      v = v.replace(FAKE_VALUE_RE, '[À COMPLÉTER]');
      // Canonicalise les placeholders bracketés (le modèle templatise parfois plusieurs emplacements :
      // « Nom, N° agrément — Nom / N° » → « [À COMPLÉTER], [À COMPLÉTER] — [À COMPLÉTER] / [À COMPLÉTER] »).
      v = v.replace(/\[\s*[àa]\s*compl[ée]ter\s*\]/gi, '[À COMPLÉTER]');
      // Si, une fois retirés les placeholders et les séparateurs, il ne reste RIEN d'utile → un seul.
      const meaningful = v.replace(/\[À COMPLÉTER\]/g, '').replace(/[\s,;:/|.\-—–()]+/g, '');
      if (!meaningful) return '[À COMPLÉTER]';
      // Fusionne les séquences de placeholders séparés par de la simple ponctuation.
      v = v.replace(/\[À COMPLÉTER\](?:\s*[,;/|—–-]+\s*\[À COMPLÉTER\])+/g, '[À COMPLÉTER]');
      // Il reste ≥2 placeholders → le modèle a recopié la STRUCTURE de la question avec des libellés
      // intermédiaires (« [À COMPLÉTER] / Date d'obtention de l'autorisation : [À COMPLÉTER] »). On
      // n'en garde qu'UN SEUL : on ne conserve que le texte qui n'est PAS un libellé déjà dans la
      // question (ex. un vrai nom de référent), et on termine par un unique [À COMPLÉTER].
      if ((v.match(/\[À COMPLÉTER\]/g) || []).length >= 2) {
        // Comparaison robuste : on ignore ponctuation/apostrophes/espaces (le libellé recopié et la
        // question ont parfois des apostrophes différentes) → "d'obtention" ≡ "d obtention".
        const alnum = (s: string) => normCtx(s).replace(/[^a-z0-9]+/g, '');
        const qn = alnum(ctx);
        const realParts = v.split(/\[À COMPLÉTER\]/)
          .map(s => s.replace(/^[\s,;:/|.\-—–()]+|[\s,;:/|.\-—–()]+$/g, '').trim())
          .filter(s => { const ns = alnum(s); return ns.length >= 3 && !qn.includes(ns); });
        return realParts.length ? `${realParts.join(' ')} [À COMPLÉTER]` : '[À COMPLÉTER]';
      }
      return v;
    };

    // ── Lignes-réponse PARASITES (sur-découpage du cadre client) ──
    // Sous un libellé, le gabarit a souvent PLUSIEURS lignes pointillées : seule la 1re est la vraie
    // zone de réponse (son champ porte le libellé comme « Question: »). Les suivantes sont détectées
    // comme des champs-réponse SANS question propre (« Question: \":\" » ou vide) → ce sont des lignes
    // EN TROP du gabarit, pas de vraies questions. On n'y laisse AUCUN texte IA : on remet la valeur à
    // VIDE → seul subsiste ce qui était DÉJÀ dans le template de référence (le « : » et les pointillés
    // sont des runs d'origine, conservés). On ne touche ni aux cellules de tableau ni aux cases.
    {
      const valById = new Map<number, string>(replacements.map(r => [r.id, String(r.value)]));
      let cleared = 0;
      for (const d of descriptors) {
        if (d.kind !== 'answer') continue;
        const q = (d.context.match(/Question:\s*"([^"]*)"/) || [])[1] || '';
        const qClean = q.replace(/[\s.:;,…\-—–/|()]+/g, '');   // question « vide » une fois la ponctuation retirée
        if (qClean.length === 0 && (valById.get(d.id) ?? '').trim()) { valById.set(d.id, ''); cleared++; }
      }
      if (cleared) console.log(`[MemoireGenerator] Lignes parasites vidées (réponse sans question propre): ${cleared}`);
      replacements.forEach(r => { if (valById.has(r.id)) r.value = valById.get(r.id)!; });
    }

    // ── Déduplication des zones SUR-DÉCOUPÉES ──
    // Certaines zones de réponse (lignes pointillées consécutives sous un même libellé, ou plusieurs
    // cellules vides d'une même ligne de tableau) sont détectées comme PLUSIEURS champs → elles
    // reçoivent la même valeur, qui se répète en cascade dans le document. Deux dédoublonnages :
    //  • VALEURS RÉDIGÉES identiques au contexte identique → on garde la 1re, on vide les suivantes ;
    //  • « [À COMPLÉTER] » purs → une seule fois par LIGNE/zone (même ligne de tableau ou même
    //    question) : inutile d'écrire « [À COMPLÉTER] » dans chaque case vide d'une même ligne.
    {
      const dedupSig = (ctx: string) => normCtx(ctx.replace(/\[CHAMP_\d+\]/g, ''));
      // Signature « ligne/zone » (plus grossière) pour regrouper les [À COMPLÉTER] d'une même ligne.
      const lineSig = (ctx: string) => {
        const section = (ctx.match(/Section:\s*"([^"]*)"/) || [])[1] || '';
        const ligne = (ctx.match(/Ligne:\s*"([^"]*)"/) || [])[1];      // cellules d'une même ligne de tableau
        const question = (ctx.match(/Question:\s*"([^"]*)"/) || [])[1]; // lignes d'une même zone de réponse
        return normCtx(section + '||' + (ligne ?? question ?? ''));
      };
      const isPureBlank = (v: string) => /^\[?\s*[àa]\s*compl[ée]ter\s*\]?\.?$/i.test(v.trim());
      const valById = new Map<number, string>(replacements.map(r => [r.id, String(r.value)]));
      const seenVal = new Map<string, Set<string>>();   // valeurs rédigées déjà vues (par contexte complet)
      const blankLines = new Set<string>();             // lignes/zones portant déjà un [À COMPLÉTER]
      for (const d of descriptors.slice().sort((a, b) => a.id - b.id)) {
        if (d.kind === 'checkbox') continue;
        const v = (valById.get(d.id) ?? '').trim();
        if (!v) continue;
        if (isPureBlank(v)) {
          const ls = lineSig(d.context);
          if (blankLines.has(ls)) { valById.set(d.id, ''); console.log(`[MemoireGenerator] [À COMPLÉTER] en trop vidé: CHAMP_${d.id} (même ligne)`); }
          else blankLines.add(ls);
          continue;
        }
        const sig = dedupSig(d.context);
        const set = seenVal.get(sig) ?? seenVal.set(sig, new Set()).get(sig)!;
        const nv = normCtx(v);
        if (set.has(nv)) { valById.set(d.id, ''); console.log(`[MemoireGenerator] Doublon vidé: CHAMP_${d.id} (même contexte/valeur)`); }
        else set.add(nv);
      }
      replacements.forEach(r => { if (valById.has(r.id)) r.value = valById.get(r.id)!; });
    }

    // 6. Apply replacements in the DOM
    let applied = 0;
    replacements.forEach((rep: any) => {
      const desc = descriptors.find(d => d.id === rep.id);
      if (!desc) return;
      const value = guardPlaceholders(guardNames(guardFactual(String(rep.value), desc.context)), desc.context);
      const isChecked = value.includes('☑') || value.toLowerCase() === 'oui' || value.toLowerCase() === 'yes' || value === '1' || value === 'true';

      if (desc.type === 'text') {
        const tEls = getElementsWithLocalName(xmlDoc, 't');
        tEls.forEach((tEl: any) => replaceTextInElement(xmlDoc, tEl, `[CHAMP_${rep.id}]`, value));
        applied++;
      } else if (desc.type === 'legacy_checkbox') {
        let checkedEl = findLocalNameChild(desc.element, 'checked');
        if (!checkedEl) {
          checkedEl = xmlDoc.createElementNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'w:checked');
          desc.element.appendChild(checkedEl);
        }
        checkedEl.setAttribute('w:val', isChecked ? '1' : '0');
        applied++;
      } else if (desc.type === 'sym_checkbox') {
        desc.element.setAttribute('w:char', isChecked ? 'F0FE' : 'F0A8');
        applied++;
      } else if (desc.type === 'w14_checkbox') {
        let checkedEl = findLocalNameChild(desc.element, 'checked');
        if (!checkedEl) {
          checkedEl = xmlDoc.createElementNS('http://schemas.microsoft.com/office/word/2010/wordml', 'w14:checked');
          desc.element.appendChild(checkedEl);
        }
        checkedEl.setAttribute('w14:val', isChecked ? '1' : '0');
        let sdt = getParentWithLocalName(desc.element, 'sdt');
        if (sdt) {
          getElementsWithLocalName(sdt, 't').forEach((t: any) => { t.textContent = isChecked ? '☒' : '☐'; });
        }
        applied++;
      }
    });

    // 7. Clean up remaining placeholders
    getElementsWithLocalName(xmlDoc, 't').forEach((tEl: any) => {
      const text = tEl.textContent || '';
      if (/\[CHAMP_\d+\]/.test(text)) tEl.textContent = text.replace(/\[CHAMP_\d+\]/g, '');
    });

    console.log(`[MemoireGenerator] Applied ${applied}/${replacements.length} replacements.`);

    // 8. Serialize and save
    const serializer = new XMLSerializer();
    zip.file('word/document.xml', serializer.serializeToString(xmlDoc));
    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const outputFileName = `Mémoire technique GSS_${Date.now()}.docx`;
    const outputPath = path.join(this.responseDir, outputFileName);
    fs.writeFileSync(outputPath, buf);

    console.log(`[MemoireGenerator] Successfully generated ${outputPath}`);

    return {
      filePath: outputPath,
      generatedData: {
        total_suggestions: String(prompts.length),
        modifications_reussies: String(applied),
        details: JSON.stringify(replacements.map(r => ({
          recherche: `[CHAMP_${r.id}]`,
          remplacement: r.value
        })))
      }
    };
  }

  /**
   * Cas "sans cadre imposé" (mode B / réponse libre) — approche PRÉSERVATION : on garde le
   * maître AO RNE.docx INTACT (design + 221 images) et on AJOUTE des pages en DUPLIQUANT des
   * pages existantes (`cloneSpread`) pour y injecter le texte personnalisé (généré côté front
   * à partir du DCE + Documentation GSS). Le nom du client du maître (« Parc des Expositions de
   * Rouen ») est remplacé par celui du DCE (`adaptStaticText`). Le round-trip DOM (xmldom)
   * préserve la maquette à l'identique (vérifié : embeds/drawings/textboxes/sections inchangés).
   */
  public async assembleFromSections(
    dossierId: string,
    chapters: AssembleChapter[],
    options: { refonte?: boolean } = {},
  ): Promise<{ filePath: string; generatedData: Record<string, string> }> {
    // Refonte V1 activée par défaut : fond gris uniforme + retrait des images de fond
    // pleine page sur les pages dupliquées (bandeau/titre conservé).
    const refonte = options.refonte !== false;
    // 0. Client (base DCE puis analyse) pour personnaliser la couverture / le sommaire.
    const cover = await this.getCoverInfo(dossierId);
    const clientName = cover.client && !/global security|^gss\b/i.test(cover.client) ? cover.client : '';

    // 1. Charger le maître AO RNE.docx et parser document.xml (médias/thème/styles conservés).
    const templatePath = path.join(this.templateDir, 'Mémoire technique', 'AO RNE.docx');
    if (!fs.existsSync(templatePath)) throw new Error(`Template de référence introuvable : ${templatePath}`);
    const zip = new PizZip(fs.readFileSync(templatePath));
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) throw new Error('word/document.xml introuvable dans AO RNE.docx');

    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    const xmlDoc = parser.parseFromString(documentXmlFile.asText(), 'text/xml');

    // Refonte V1 — fond gris uniforme : <w:background> en 1er enfant du document +
    // activation du rendu via <w:displayBackgroundShape/> dans settings.xml.
    if (refonte) {
      const docEl = xmlDoc.documentElement;
      if (docEl && !findLocalNameChild(docEl, 'background')) {
        const bg = xmlDoc.createElementNS(W_NS, 'w:background');
        bg.setAttribute('w:color', BACKGROUND_COLOR);
        docEl.insertBefore(bg, docEl.firstChild);
      }
      const settingsFile = zip.file('word/settings.xml');
      if (settingsFile) {
        let s = settingsFile.asText();
        if (!/displayBackgroundShape/.test(s)) {
          s = s.replace(/(<w:settings[^>]*>)/, '$1<w:displayBackgroundShape/>');
          zip.file('word/settings.xml', s);
        }
      }
    }

    // 2. Personnalisation du client (couverture/sommaire) sur le document + en-têtes/pieds.
    if (clientName) {
      this.adaptStaticText(xmlDoc, { clientName });
      Object.keys(zip.files).forEach((name) => {
        if (name.startsWith('word/header') || name.startsWith('word/footer')) {
          const fd = zip.file(name);
          if (!fd) return;
          const hf = parser.parseFromString(fd.asText(), 'text/xml');
          this.adaptStaticText(hf, { clientName });
          zip.file(name, serializer.serializeToString(hf));
        }
      });
    }

    // 3. Découper le corps en sections OOXML puis repérer les "spreads" (page image+titre + corps).
    const body = findLocalNameChild(xmlDoc.documentElement, 'body');
    if (!body) throw new Error('<w:body> introuvable dans AO RNE.docx');
    const { sections } = splitBodyIntoSections(body);

    interface Spread { headingParas: any[]; bodyParas: any[]; headingText: string; }
    const spreads: Spread[] = [];
    for (let i = 0; i < sections.length - 1; i++) {
      if (sectionHasBackgroundImage(sections[i]) && sectionHasTextbox(sections[i]) && sectionIsPlainText(sections[i + 1])) {
        const headingText = sections[i]
          .flatMap((p: any) => getElementsWithLocalName(p, 'txbxContent'))
          .flatMap((tx: any) => getElementsWithLocalName(tx, 't'))
          .map((t: any) => t.textContent || '')
          .join(' ');
        spreads.push({ headingParas: sections[i], bodyParas: sections[i + 1], headingText });
      }
    }
    if (spreads.length === 0) throw new Error('Aucune page-modèle (spread image+titre+corps) repérée dans AO RNE.docx.');

    // 4. Aplatir les sections générées ; pour chacune, dupliquer la page-modèle du bon thème
    //    et y injecter titre + texte. Insertion juste après la page-modèle correspondante.
    const flat: Array<{ title: string; text: string }> = [];
    chapters.forEach((ch) =>
      (ch?.sections || []).forEach((s) => { if (s?.text?.trim()) flat.push({ title: (s.title || '').trim(), text: s.text }); }),
    );
    if (flat.length === 0) throw new Error('Aucune section générée à insérer (sections vides).');

    const scoreMatch = (title: string, heading: string): number => {
      const want = new Set(normTitle(title).split(' ').filter((w) => w.length > 3));
      let s = 0;
      normTitle(heading).split(' ').forEach((w) => { if (w.length > 3 && want.has(w)) s++; });
      return s;
    };

    const counter = { v: maxDrawingId(xmlDoc) };
    const stats = { imagesRemoved: 0 };
    const lastInsertedByBody = new Map<any, any>(); // empile plusieurs ajouts après une même page-modèle
    // Récupérer le fond gris clair (#D9D9D9) pleine page pour l'injecter dans les corps dupliqués
    const bgRun = findFullPageBackgroundRun(body);
    if (bgRun) {
      console.log('[MemoireGenerator] Fond gris clair (#D9D9D9) pleine page trouvé — injection dans les pages dupliquées.');
    }
    // Récupérer le bandeau « GSS » de titre pour le poser sur chaque page générée
    const gssRun = findGssBannerRun(body);
    if (gssRun) {
      console.log('[MemoireGenerator] Bandeau « GSS » de titre trouvé — injection sur chaque titre généré.');
    } else {
      console.warn('[MemoireGenerator] Bandeau « GSS » de titre NON trouvé.');
    }
    let inserted = 0;
    flat.forEach((sec, idx) => {
      // Dernière page : utiliser le dernier spread du template (image pleine page étendue)
      const isLastPage = idx === flat.length - 1;
      let best = isLastPage ? spreads[spreads.length - 1] : spreads[idx % spreads.length];
      if (!isLastPage) {
        let bestScore = 0;
        spreads.forEach((sp) => { const sc = scoreMatch(sec.title, sp.headingText); if (sc > bestScore) { bestScore = sc; best = sp; } });
      }

      const useRefonte = refonte && !isLastPage;
      const newNodes = cloneSpread(xmlDoc, best.headingParas, best.bodyParas, counter, sec.title, sec.text, useRefonte, stats);

      const headingCount = best.headingParas.length;

      // La dernière page utilise le spread de clôture (image pleine page) : on retire son
      // image de fond pour laisser apparaître le fond gris, comme sur les autres pages.
      if (isLastPage) {
        stats.imagesRemoved += stripStandaloneBgImages(newNodes.slice(0, headingCount));
      }

      // Injecter le fond gris clair pleine page dans la section corps de TOUTES les pages
      // générées (y compris la dernière) — le client veut le fond gris partout.
      if (bgRun) {
        const bodyNodes = newNodes.slice(headingCount);
        if (bodyNodes.length > 0) {
          injectFullPageBackground(bodyNodes, bgRun, counter);
        }
      }

      // Poser le bandeau « GSS » sur le titre de chaque page générée (certains en-têtes
      // du template ne le portent pas) — garantit un titre cohérent partout.
      if (gssRun) {
        injectGssBanner(newNodes.slice(0, headingCount), gssRun, counter);
      }

      const anchorBody = best.bodyParas[best.bodyParas.length - 1];
      const ref = (lastInsertedByBody.get(anchorBody) || anchorBody).nextSibling;
      let last: any = null;
      newNodes.forEach((n) => { body.insertBefore(n, ref); last = n; });
      lastInsertedByBody.set(anchorBody, last);
      inserted++;
    });

    // 5. Sérialiser document.xml (médias conservés) et sauvegarder.
    zip.file('word/document.xml', serializer.serializeToString(xmlDoc));
    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const outputFileName = `Mémoire technique GSS_${Date.now()}.docx`;
    const outputPath = path.join(this.responseDir, outputFileName);
    fs.writeFileSync(outputPath, buf);

    console.log(`[MemoireGenerator] AO RNE personnalisé : ${inserted} page(s) ajoutée(s), ${spreads.length} page(s)-modèle, refonte=${refonte} (fond gris ${refonte ? BACKGROUND_COLOR : 'off'}, ${stats.imagesRemoved} image(s) de fond retirée(s)), client="${clientName || '(non personnalisé)'}" → ${outputPath}`);

    return {
      filePath: outputPath,
      generatedData: {
        mode: refonte
          ? `Refonte V1 : fond gris uniforme #${BACKGROUND_COLOR} + bandeau conservé + images de fond retirées des pages dupliquées`
          : 'AO RNE préservé (design intact) + pages dupliquées',
        client: clientName || '(non personnalisé)',
        pages_ajoutees: String(inserted),
        pages_modeles: String(spreads.length),
        images_fond_retirees: String(stats.imagesRemoved),
      },
    };
  }

  /**
   * Construit un DOCX NU (sans cadre, sans le maître AO RNE) : styles Word par défaut,
   * aucun fond de page, aucun en-tête/pied, aucune page de garde. Sert de point de
   * comparaison « génération sans template » face au template refondu.
   */
  public async assembleNoTemplate(
    chapters: AssembleChapter[],
  ): Promise<{ filePath: string; generatedData: Record<string, string> }> {
    const esc = (s: string) => escXml(s);
    const plainRun = (t: string, bold = false, sz?: number) =>
      `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${sz ? `<w:sz w:val="${sz}"/>` : ''}</w:rPr>` +
      `<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
    const plainPara = (inner: string) => `<w:p>${inner}</w:p>`;

    const body: string[] = [];
    let chaptersOut = 0;
    let sectionsOut = 0;
    chapters.forEach((chapter, idx) => {
      if (!chapter || !chapter.sections || chapter.sections.length === 0) return;
      const roman = chapter.key || ['I', 'II', 'III', 'IV', 'V', 'VI'][idx] || String(idx + 1);
      body.push(plainPara(plainRun(`${roman}. ${chapter.title || ''}`.trim(), true, 32)));
      for (const sec of chapter.sections) {
        const title = sec.title?.trim();
        if (title) body.push(plainPara(plainRun(title, true, 26)));
        for (const rawLine of String(sec.text || '').replace(/\r\n/g, '\n').split('\n')) {
          const line = rawLine.replace(/[`#*_>-]/g, '').trim();
          if (line) body.push(plainPara(plainRun(line)));
        }
        sectionsOut++;
      }
      chaptersOut++;
    });

    if (chaptersOut === 0) throw new Error('Aucun chapitre généré à exporter (sections vides).');

    const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document xmlns:w="${W_NS}"><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

    const zip = new PizZip();
    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>');
    zip.file('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>');
    zip.file('word/document.xml', documentXml);
    zip.file('word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');

    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const outputFileName = `Mémoire technique GSS (sans template)_${Date.now()}.docx`;
    const outputPath = path.join(this.responseDir, outputFileName);
    fs.writeFileSync(outputPath, buf);

    console.log(`[MemoireGenerator] Mémoire NU (sans template) généré : ${chaptersOut} chapitre(s), ${sectionsOut} section(s) → ${outputPath}`);

    return {
      filePath: outputPath,
      generatedData: {
        mode: 'Document nu (sans template, styles Word par défaut)',
        chapitres: String(chaptersOut),
        sections: String(sectionsOut),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // GÉNÉRATION COMPLÈTE DU MÉMOIRE (sans cadre imposé dans le DCE)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Charge la Documentation GSS (Template/Documentation GSS/) — 21 catégories de PDFs
   * (ABSENCE ET RETARD, FORMATION, PROCEDURE, TENUES, etc.). Renvoie un dictionnaire
   * { catégorie: texte } budgétisé par catégorie.
   */
  private async getGssDocumentation(): Promise<Record<string, string>> {
    const gssDir = path.join(this.templateDir, 'Documentation GSS');
    if (!fs.existsSync(gssDir)) {
      console.warn('[MemoireGenerator] Documentation GSS introuvable:', gssDir);
      return {};
    }

    const PER_CAT_CAP = 15_000; // plafond par catégorie en caractères
    const categories: Record<string, string> = {};

    for (const entry of fs.readdirSync(gssDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Le dossier « Personnes » (référents GSS) est chargé à part via getGssReferents().
      if (entry.name.toLowerCase() === 'personnes') continue;
      const catDir = path.join(gssDir, entry.name);
      let catText = '';

      const files = fs.readdirSync(catDir).filter(f => f.toLowerCase().endsWith('.pdf'));
      for (const file of files) {
        try {
          const text = await extractText(path.join(catDir, file));
          if (text.length > 50) catText += `\n--- ${file} ---\n${text}`;
        } catch (e: any) {
          console.warn(`[MemoireGenerator] GSS doc: impossible de lire ${entry.name}/${file}: ${e.message}`);
        }
      }

      if (catText.trim()) {
        categories[entry.name] = catText.length > PER_CAT_CAP
          ? catText.slice(0, PER_CAT_CAP) + '\n[… tronqué …]'
          : catText;
        console.log(`[MemoireGenerator] GSS doc chargée: ${entry.name} — ${catText.length} chars (${files.length} fichiers)`);
      }
    }

    console.log(`[MemoireGenerator] Documentation GSS: ${Object.keys(categories).length} catégories chargées.`);
    return categories;
  }

  /**
   * Concatène TOUTE la Documentation GSS (toutes les catégories/sous-dossiers) en un seul
   * contexte de connaissances budgétisé, pour le remplissage d'un cadre client : chaque champ
   * du formulaire doit pouvoir être renseigné à partir de ce que GSS sait faire. Plafonné par
   * catégorie ET globalement pour rester sous la limite TPM.
   */
  private buildFullGssContext(gssDocs: Record<string, string>, perCatCap = 2500, totalCap = 24_000): string {
    let ctx = '';
    for (const [cat, text] of Object.entries(gssDocs)) {
      if (ctx.length >= totalCap) break;
      ctx += `\n\n=== Doc GSS : ${cat} ===\n${text.slice(0, perCatCap)}`;
    }
    return ctx.length > totalCap ? ctx.slice(0, totalCap) + '\n[… tronqué …]' : ctx;
  }

  /**
   * Charge la liste des RÉFÉRENTS GSS depuis « Template/Documentation GSS/Personnes » (interlocuteurs
   * uniques, encadrants, contacts, dirigeants). « Personnes » peut être SOIT un fichier texte simple
   * (un référent par ligne, sans extension), SOIT un dossier de fiches (pdf/docx/doc/txt) : les deux
   * cas sont gérés. Renvoie le texte concaténé (budgétisé) ou '' si absent/vide — dans ce dernier cas
   * les champs « référent » resteront « [À COMPLÉTER] » plutôt qu'inventés.
   */
  private async getGssReferents(): Promise<string> {
    const target = path.join(this.templateDir, 'Documentation GSS', 'Personnes');
    if (!fs.existsSync(target)) {
      console.warn('[MemoireGenerator] « Personnes » (référents GSS) introuvable:', target);
      return '';
    }

    const CAP = 12_000;
    /** Lit un fichier : texte brut s'il n'a pas d'extension exploitable, sinon via extractText. */
    const readOne = async (filePath: string): Promise<string> => {
      try {
        if (/\.(pdf|docx?)$/i.test(filePath)) return await extractText(filePath);
        return fs.readFileSync(filePath, 'utf8'); // .txt ou fichier sans extension (liste texte)
      } catch (e: any) {
        console.warn(`[MemoireGenerator] Référents: impossible de lire ${path.basename(filePath)}: ${e.message}`);
        return '';
      }
    };

    let out = '';
    if (fs.statSync(target).isDirectory()) {
      for (const file of fs.readdirSync(target)) {
        const text = (await readOne(path.join(target, file))).trim();
        if (text.length > 30) out += `\n--- ${file} ---\n${text}`;
      }
    } else {
      out = (await readOne(target)).trim();
    }

    out = out.trim();
    if (out.length > CAP) out = out.slice(0, CAP) + '\n[… tronqué …]';
    console.log(`[MemoireGenerator] Référents GSS (Personnes): ${out.length} chars chargés.`);
    return out;
  }

  /**
   * Trouve les catégories de Documentation GSS pertinentes pour un titre de spread donné,
   * par correspondance de mots-clés dans GSS_DOC_KEYWORDS. Si `analysisData` est fourni,
   * les catégories sont pondérées par pertinence au secteur du client (ex : FORMATION
   * prioritaire pour l'éducation, PROCEDURE pour l'industrie).
   */
  private matchGssCategories(spreadTitle: string, availableCategories: string[], analysisData?: any): string[] {
    const n = normTitle(spreadTitle);

    // Score de base : correspondance titre ↔ mots-clés de la catégorie
    const scored: Array<{ cat: string; score: number }> = [];

    for (const [cat, keywords] of Object.entries(GSS_DOC_KEYWORDS)) {
      if (!availableCategories.includes(cat)) continue;
      let score = 0;
      for (const kw of keywords) {
        if (n.includes(kw)) score += 2;
      }
      if (score > 0) scored.push({ cat, score });
    }

    // Fallback : correspondance par mots du titre dans les noms de catégories
    if (scored.length === 0) {
      const words = n.split(' ').filter(w => w.length > 3);
      for (const cat of availableCategories) {
        const catNorm = normTitle(cat);
        if (words.some(w => catNorm.includes(w))) scored.push({ cat, score: 1 });
      }
    }

    // Bonus sectoriel : prioriser les catégories pertinentes au secteur du client
    if (analysisData) {
      const sector = detectClientSector(analysisData).toLowerCase();
      const sectorBoosts: Record<string, string[]> = {
        'education': ['FORMATION', 'FORMATION INTERNE', 'SUIVI QUALITE ET CONTROLES', 'PROCEDURE'],
        'enseignement': ['FORMATION', 'FORMATION INTERNE', 'SUIVI QUALITE ET CONTROLES', 'PROCEDURE'],
        'sante': ['PROCEDURE', 'FORMATION', 'TENUES', 'SUIVI QUALITE ET CONTROLES'],
        'hospitalier': ['PROCEDURE', 'FORMATION', 'TENUES', 'SUIVI QUALITE ET CONTROLES'],
        'industrie': ['PROCEDURE', 'MATERIEL', 'TENUES', 'FORMATION'],
        'logistique': ['PROCEDURE', 'MATERIEL', "MOYENS D'ACCES", 'PLANNIFICATION'],
        'distribution': ["MOYENS D'ACCES", 'PROCEDURE', 'TENUES', 'MATERIEL'],
        'commerce': ["MOYENS D'ACCES", 'PROCEDURE', 'TENUES', 'MATERIEL'],
        'evenementiel': ['PLANNIFICATION', 'PROCEDURE', 'MATERIEL', 'EFFECTIFS ET ORGANIGRAMME'],
        'culture': ['PLANNIFICATION', 'PROCEDURE', 'MATERIEL', 'EFFECTIFS ET ORGANIGRAMME'],
        'transport': ['PROCEDURE', 'MATERIEL', "MOYENS D'ACCES", 'SUIVI QUALITE ET CONTROLES'],
        'collectivite': ['MANAGEMENT', 'SUIVI QUALITE ET CONTROLES', 'ENGAGEMENT ECOLOGIQUE', 'VALEURS'],
        'residentiel': ['PROCEDURE', 'INTERLOCUTEUR UNIQUE', 'PLANNIFICATION', "MOYENS D'ACCES"],
      };
      for (const [sectorKey, boostedCats] of Object.entries(sectorBoosts)) {
        if (sector.includes(sectorKey)) {
          for (const s of scored) {
            if (boostedCats.includes(s.cat)) s.score += 1;
          }
          break;
        }
      }

      // Bonus marché public : prioriser MANAGEMENT et SUIVI QUALITE
      const marketType = detectMarketType(analysisData);
      if (marketType === 'public') {
        for (const s of scored) {
          if (['MANAGEMENT', 'SUIVI QUALITE ET CONTROLES', 'ENGAGEMENT ECOLOGIQUE', 'VALEURS'].includes(s.cat)) {
            s.score += 1;
          }
        }
      }
    }

    // Tri par score décroissant, 4 catégories max
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 4).map(s => s.cat);
  }

  /**
   * Génération COMPLÈTE du mémoire technique quand AUCUN cadre de réponse n'est dans le DCE.
   *
   * Approche en 3 temps :
   * A) MODIFIER les 119 pages existantes d'AO RNE.docx : pour chaque spread (page image+titre
   *    + page corps de texte), on génère un texte personnalisé via IA en se basant UNIQUEMENT
   *    sur le DCE + Documentation GSS, et on remplace le corps de texte en conservant le design.
   * B) AJOUTER des pages supplémentaires pour les thématiques du DCE non couvertes, en dupliquant
   *    des pages-modèles existantes (cloneSpread) pour préserver le design complexe.
   * C) Personnaliser le nom du client sur la couverture, en-têtes et pieds de page.
   *
   * Sources de données : DCE (CCTP, RC, annexes) + Documentation GSS (21 catégories de PDFs).
   */
  public async generateFullMemoire(dossierId: string): Promise<{ filePath: string, generatedData: Record<string, string> }> {
    console.log(`[MemoireGenerator] ═══ Génération ciblée du mémoire (AO RNE intact + synthèse personnalisée) ═══`);

    // ── 1. Analyse structurée du DCE ──
    const dceContext = await this.getDceContext(dossierId);
    const analysisData = await this.analyzeDce(dceContext);
    const analysisJson = JSON.stringify(analysisData, null, 2);
    const clientName = analysisData?.clientName || 'le client';
    console.log(`[MemoireGenerator] Analyse DCE terminée: client="${clientName}"`);

    // ── 2. Chargement de la Documentation GSS (Limité pour la synthèse) ──
    const gssDocs = await this.getGssDocumentation();
    let gssContext = '';
    const priorityCats = ['MANAGEMENT', 'INTERLOCUTEUR UNIQUE', 'MISE EN PLACE', 'VALEURS', 'SUIVI QUALITE ET CONTROLES'];
    for (const cat of priorityCats) {
      if (gssDocs[cat]) {
        gssContext += `\n\n=== Doc GSS : ${cat} ===\n${gssDocs[cat].slice(0, 5000)}`;
      }
    }

    // ── 3. Charger et parser AO RNE.docx ──
    const templatePath = path.join(this.templateDir, 'Mémoire technique', 'AO RNE.docx');
    if (!fs.existsSync(templatePath)) throw new Error(`Template AO RNE introuvable: ${templatePath}`);
    const zip = new PizZip(fs.readFileSync(templatePath));
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) throw new Error('word/document.xml introuvable dans AO RNE.docx');

    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    const xmlDoc = parser.parseFromString(documentXmlFile.asText(), 'text/xml');

    // ── 4. Personnaliser le nom du client (couverture + en-têtes/pieds) ──
    this.adaptStaticText(xmlDoc, analysisData);
    Object.keys(zip.files).forEach(name => {
      if (name.startsWith('word/header') || name.startsWith('word/footer')) {
        const fd = zip.file(name);
        if (!fd) return;
        const hfDoc = parser.parseFromString(fd.asText(), 'text/xml');
        this.adaptStaticText(hfDoc, analysisData);
        zip.file(name, serializer.serializeToString(hfDoc));
      }
    });

    // ── 5. Récupérer le corps du document ──
    const body = findLocalNameChild(xmlDoc.documentElement, 'body');
    if (!body) throw new Error('<w:body> introuvable dans AO RNE.docx');

    const zones = findContextZones(body);
    if (zones.length === 0) {
      throw new Error('Aucune zone « Contexte sur mesure » (balise début/fin) trouvée dans AO RNE.docx — impossible d\'insérer la synthèse.');
    }

    // ── 6. Génération IA de la synthèse personnalisée (1 seule génération ciblée) ──
    // Capacité = nombre de lignes vides réservées (entre début/fin) × largeur de ligne ; on vise de
    // quoi remplir l'espace réservé sans déborder (le surplus serait tronqué pour ne rien décaler).
    const totalLines = zones.reduce((s, z) => s + z.blanks.length + z.postBlanks.length, 0);
    const totalCapacity = totalLines * CHARS_PER_LINE_2COL;
    console.log(`[MemoireGenerator] ${zones.length} zone(s) « Contexte sur mesure » (début/fin), ${totalLines} ligne(s) réservée(s), capacité ~${totalCapacity} caractères. Génération IA de la synthèse...`);
    const targetWords = Math.max(400, Math.round(totalCapacity / 6.5)); // ~6.5 car/mot
    const marketType = detectMarketType(analysisData);
    const clientSector = detectClientSector(analysisData);
    const strategicCtx = buildStrategicContext('presentation', analysisData);
    const systemPrompt = `Tu es un expert en sécurité privée chez GSS. Rédige une "Synthèse de l'offre" complète (environ ${targetWords} mots) qui sera ajoutée en introduction du mémoire technique.
- Basé UNIQUEMENT sur l'analyse du DCE et les atouts GSS.
- Personnalise un maximum pour le client : nom, sites, enjeux, risques anticipés.
- Mets en avant l'accompagnement GSS (interlocuteur unique, qualité, réactivité).
- CADRE DU MARCHÉ : Ce marché est un marché ${marketType === 'public' ? 'PUBLIC — utilise le vocabulaire de la commande publique (pouvoir adjudicateur, titulaire, sous-critères), cite les obligations du CCP et mets en avant les garanties de conformité et la transparence' : 'PRIVÉ — adopte un ton commercial direct, mets en avant la flexibilité, les SLA sur mesure et l\'adaptation aux process internes du client'}. Secteur : ${clientSector}.
- STRATÉGIE : chaque paragraphe doit démontrer que GSS a COMPRIS L'ENJEU du client. Structure-le ainsi : (1) l'enjeu/risque concret de CE client (issu de l'analyse), (2) la réponse GSS DIFFÉRENCIANTE qui y répond (un moyen, une méthode ou engagement précis, pas un slogan), (3) le bénéfice tangible pour le client. Propose un VRAI AVANTAGE, pas une promesse interchangeable.
- INTÈGRE les solutions GSS spécifiques fournies dans le contexte stratégique ci-dessous. Ce sont des arguments concrets et vérifiés que tu dois reformuler naturellement dans le texte.
- Rédige plusieurs paragraphes bien développés (un paragraphe par idée, séparés par un saut de ligne).
- IMPORTANT : N'utilise AUCUNE liste à puces (aucun tiret, aucun bullet point, aucun symbole). Rédige UNIQUEMENT sous forme de texte continu en paragraphes complets. Pas de markdown.
- Le ton doit être professionnel, rassurant et très commercial (vendre l'offre).`;

    const userPrompt = `ANALYSE DU MARCHÉ (DCE) :\n${analysisJson}\n\n--- CONTEXTE STRATÉGIQUE GSS (solutions spécifiques à ce client ${marketType}) ---\n${strategicCtx}\n\nATOUTS GSS (Extrait doc) :\n${gssContext}\n\nRédige le texte de la synthèse de notre offre sur mesure pour ce client.`;

    const generatedText = await this.callOpenAI(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      0.5, 'Génération Synthèse', false
    );

    if (!generatedText) throw new Error('Échec de la génération IA de la synthèse.');

    // ── 7. Remplir les zones « Contexte sur mesure » (texte en continuité, sur place) ──
    // On ne reconstruit plus la DA : les pages sont déjà designées (titre, fond, bandeau, colonnes).
    // On écrit le texte dans les lignes vides réservées (entre début et fin), sans déborder, en
    // préservant la section de chaque ligne → les zones prévues en 2 colonnes coulent gauche→droite.
    const fillResult = fillContextMarkers(body, generatedText);
    console.log(`[MemoireGenerator] Synthèse insérée : ${generatedText.length} caractères sur ${fillResult.pagesUsed}/${fillResult.markers} zone(s), ${fillResult.linesFilled} ligne(s) réservée(s) remplie(s)${fillResult.truncated ? ', texte tronqué pour ne pas déborder' : ''}.`);

    // ── 8. Sérialiser et sauvegarder (structure AO RNE 100% intacte + 1 section ajoutée) ──
    zip.file('word/document.xml', serializer.serializeToString(xmlDoc));
    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const outputFileName = `Mémoire technique GSS_${Date.now()}.docx`;
    const outputPath = path.join(this.responseDir, outputFileName);
    fs.writeFileSync(outputPath, buf);

    console.log(`[MemoireGenerator] ═══ Mémoire généré : AO RNE intact + page synthèse ajoutée → ${outputPath} ═══`);

    return {
      filePath: outputPath,
      generatedData: {
        mode: 'AO RNE intact + Synthèse personnalisée insérée (DCE + GSS)',
        client: clientName,
        texte_ajoute: String(generatedText.length) + ' caractères',
      },
    };
  }

  /**
   * Construit, en UN appel IA, une stratégie de sûreté propre au client puis le texte de CHAQUE page
   * de synthèse (un angle distinct par page, cf. STRATEGY_BEATS). L'entrée est `analysisData` (compact),
   * PAS le DCE brut → prompt léger (évite la limite TPM). Réutilise les helpers de profilage existants
   * (type marché, secteur, cadre réglementaire, solutions GSS) et active enfin keyRisks /
   * gssStrategicRecommendations. Renvoie { profile, stakes[], axes[], pages[] } avec pages.length == nZones.
   */
  private async buildClientStrategy(
    analysisData: any, nZones: number, gssContext: string, perZoneCapWords: number[],
  ): Promise<{ profile: string; stakes: string[]; axes: string[]; pages: string[] }> {
    const clientName = analysisData?.clientName || 'le client';
    const sites: string[] = (analysisData?.sites || []).map((s: any) => (s?.name || '').trim()).filter(Boolean);
    const marketType = detectMarketType(analysisData);
    const sector = detectClientSector(analysisData);
    const regulatory = buildRegulatoryFramework(marketType, sector, analysisData);
    const strategicCtx = buildStrategicContext('presentation', analysisData);
    const beats = assignBeats(nZones);

    const pagesSpec = beats.map((b, i) =>
      `Page ${i + 1} (~${perZoneCapWords[i] ?? 180} mots) — ANGLE : ${b}`).join('\n');

    const systemPrompt = `Tu es un expert en sûreté/sécurité privée chez GSS (Global Security Service). Tu prépares la "Synthèse de notre offre sur mesure" d'un mémoire technique, à partir de l'analyse d'un DCE.

DÉMARCHE OBLIGATOIRE :
1) COMPRENDS le client : déduis son TYPE d'organisation, sa mission, ses USAGERS et parties prenantes (ex. université publique → étudiants, enseignants, personnels, visiteurs, campus multi-sites, calendrier universitaire, vie nocturne ; hôpital → patients, soignants, urgences 24/7 ; site industriel → ouvriers, ICPE, flux logistiques…), et les caractéristiques de ses sites.
2) DÉDUIS les ENJEUX de sûreté SPÉCIFIQUES à ce profil (pas génériques).
3) POSE 3 à 4 AXES STRATÉGIQUES différenciants GSS qui répondent précisément à ces enjeux.
4) RÉDIGE le texte de CHAQUE page selon l'angle imposé ci-dessous, en t'appuyant sur le profil et les axes.

RÈGLES DE RÉDACTION (champ "pages") :
- Marché ${marketType === 'public' ? 'PUBLIC : vocabulaire de la commande publique, obligations du CCP, conformité, transparence, pénalités' : 'PRIVÉ : ton commercial, flexibilité, SLA sur mesure, adaptation aux process internes'}. Secteur : ${sector}.
- PERSONNALISE : cite le nom du client (${clientName})${sites.length ? ` et ses sites (${sites.slice(0, 6).join(', ')})` : ''}, ses enjeux réels.
- Chaque paragraphe = (1) enjeu PRÉCIS du client → (2) réponse GSS différenciante (un moyen, une méthode, un engagement chiffré) → (3) bénéfice concret. Jamais de slogan vague ni de texte recyclable pour un autre marché.
- Reste COHÉRENT avec les axes posés. Respecte l'angle de chaque page (pas de redite d'une page à l'autre).
- AUCUN markdown, puce, symbole ni titre : uniquement du texte rédigé continu. Pas de conclusion générique.
- Vise le nombre de mots indiqué par page (remplir le cadre sans le dépasser largement).

Réponds en JSON valide : { "profile": string, "stakes": string[], "axes": string[], "pages": string[] } où pages a EXACTEMENT ${nZones} éléments (1 par page, dans l'ordre).`;

    const userPrompt = `ANALYSE DU MARCHÉ (DCE) :
${JSON.stringify(analysisData, null, 2).slice(0, 30_000)}

--- CONTEXTE STRATÉGIQUE GSS (cadre ${marketType}) ---
${strategicCtx}

CADRE RÉGLEMENTAIRE : ${regulatory}

ATOUTS GSS (extraits doc) :
${(gssContext || '').slice(0, 12_000)}

PLAN DES PAGES (un angle distinct par page) :
${pagesSpec}

Rends le JSON décrit (profile, stakes, axes, pages[${nZones}]).`;

    const content = await this.callOpenAI(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      0.5, 'Stratégie client + texte par page', true,
    );
    let parsed: any = {};
    try { parsed = JSON.parse(content || '{}'); } catch { parsed = {}; }
    let pages: string[] = Array.isArray(parsed.pages) ? parsed.pages.map((p: any) => String(p || '').trim()) : [];
    // Garantir EXACTEMENT nZones entrées (le remplissage par zone l'exige).
    if (pages.length > nZones) pages = pages.slice(0, nZones);
    while (pages.length < nZones) pages.push('');
    return {
      profile: String(parsed.profile || '').trim(),
      stakes: Array.isArray(parsed.stakes) ? parsed.stakes.map((s: any) => String(s || '').trim()).filter(Boolean) : [],
      axes: Array.isArray(parsed.axes) ? parsed.axes.map((s: any) => String(s || '').trim()).filter(Boolean) : [],
      pages,
    };
  }

  /**
   * Génère le mémoire en SUPERPOSANT la synthèse IA sur AO RNE.pdf (design figé) : le texte est
   * dessiné dans le cadre délimité par les balises « Contexte sur mesure début/fin » (pages 5–8),
   * en 2 colonnes, sans déborder. Aucun reflux possible → la mise en page reste intacte. Sortie PDF.
   */
  public async generateSynthesisPdf(dossierId: string): Promise<{ filePath: string, generatedData: Record<string, string> }> {
    console.log('[MemoireGenerator] ═══ Génération PDF (overlay synthèse sur AO RNE.pdf) ═══');

    // 1. Analyse DCE + contexte GSS (mêmes sources que la génération docx).
    const dceContext = await this.getDceContext(dossierId);
    const analysisData = await this.analyzeDce(dceContext);
    const clientName = analysisData?.clientName || 'le client';

    const gssDocs = await this.getGssDocumentation();
    let gssContext = '';
    for (const cat of ['MANAGEMENT', 'INTERLOCUTEUR UNIQUE', 'MISE EN PLACE', 'VALEURS', 'SUIVI QUALITE ET CONTROLES']) {
      if (gssDocs[cat]) gssContext += `\n\n=== Doc GSS : ${cat} ===\n${gssDocs[cat].slice(0, 7000)}`;
    }

    // 2. Mesurer la capacité des 4 cadres AVANT de générer, pour dimensionner le texte (remplir
    //    presque entièrement sans coder en dur un nombre de mots).
    const pdfPath = path.join(this.templateDir, 'Mémoire technique', 'AO RNE.pdf');
    if (!fs.existsSync(pdfPath)) throw new Error(`Template PDF introuvable: ${pdfPath}`);
    const pdfBuffer = fs.readFileSync(pdfPath);
    const fontBytes = loadTrebuchetFont();
    const cap = await measureZonesCapacity(pdfBuffer, fontBytes);
    const nZones = Math.max(1, cap.zones);
    // Budget de mots PAR zone (capacité réelle du cadre, ~6.5 car/mot, marge anti-débordement) → chaque
    // page est dimensionnée indépendamment ; le surplus éventuel est tronqué zone par zone par l'overlay.
    const perZoneCapWords = (cap.perZoneLines.length ? cap.perZoneLines : [cap.totalLines])
      .map((lines) => Math.max(60, Math.round((lines * cap.charsPerLine) / 6.5 * 0.95)));
    console.log(`[MemoireGenerator] Capacité des cadres : ${cap.zones} zone(s), ${cap.totalLines} ligne(s), ~${cap.charsPerLine} car/ligne → cibles/page (mots) : [${perZoneCapWords.join(', ')}].`);

    // 3. Stratégie sur-mesure + texte PAR PAGE : l'IA comprend le profil du client (type, usagers,
    //    enjeux), pose des axes, puis rédige un angle DISTINCT par page (cf. STRATEGY_BEATS).
    const strat = await this.buildClientStrategy(analysisData, nZones, gssContext, perZoneCapWords);
    const zoneTexts = strat.pages;
    if (!zoneTexts.some((t) => t.trim())) throw new Error('Échec de la génération IA de la synthèse (stratégie vide).');
    console.log(`[MemoireGenerator] Stratégie client : profil="${strat.profile.slice(0, 90)}…", ${strat.axes.length} axe(s) [${strat.axes.map((a) => a.slice(0, 40)).join(' | ')}], ${zoneTexts.filter((t) => t.trim()).length}/${nZones} page(s) rédigée(s).`);

    // 4. Personnalisation des références figées (ancien client/sites → DCE) par masque+redraw.
    //    On ne touche QUE des occurrences bien délimitées (listes de sites, libellés « BASÉ À »),
    //    jamais les phrases narratives ni la couverture (risque de rustine). Couleurs = corps gris.
    const siteNames: string[] = (analysisData?.sites || [])
      .map((s: any) => (s?.name || '').trim()).filter(Boolean);
    const refCtx: RefContext = { sites: siteNames, client: clientName, marketRef: analysisData?.marketRef || '' };
    // IMPORTANT : on NE réécrit PAS la localisation des pages « Ils nous ont fait confiance » (CESI,
    // QRM…) ni la ville des CV agents. Ce sont des FAITS réels (références passées, agents basés à Rouen) :
    // les remplacer par les sites du prospect les rend faux et fait « référence retouchée », ce qui dessert
    // l'offre. On ne corrige donc QUE les fuites manifestes de l'ancien template vers le client du marché.
    const replacements: RefReplacement[] = [
      // Fuite template : « …sites de Carrefour Mondeville » (phrase de présentation des contrôleurs) → client du DCE.
      { match: /Carrefour\s+Mondeville/gi, build: (c) => c.client },
    ];

    // 5. Overlay sur AO RNE.pdf (réutilise le buffer/police déjà chargés) + remplacements de références.
    //    Les passages SURLIGNÉS sont traités séparément, en Python (voir étape 6).
    // Remplissage PAR ZONE : la page i reçoit zoneTexts[i] (angle dédié), bornée à la capacité du cadre.
    const synthesisChars = zoneTexts.reduce((s, t) => s + t.length, 0);
    const { bytes, zonesUsed, linesDrawn, truncated, refsReplaced } =
      await overlaySynthesis(pdfBuffer, zoneTexts.join('\n\n'), fontBytes, replacements, refCtx, [], { zoneTexts, docTitle: `AO ${clientName}` });

    const outputFileName = `Mémoire technique GSS_${Date.now()}.pdf`;
    const outputPath = path.join(this.responseDir, outputFileName);

    // 6. Réécriture des passages SURLIGNÉS via Python (PyMuPDF → GPT → PyMuPDF) : PyMuPDF détecte les
    //    surlignages jaunes posés par l'utilisateur DANS le PDF + extrait le texte, GPT réécrit chaque
    //    passage adapté au client du DCE, puis PyMuPDF SUPPRIME l'ancien texte et insère le nouveau à
    //    la même taille. On écrit d'abord le PDF de synthèse (intermédiaire), puis Python produit le final.
    const interimPath = outputPath.replace(/\.pdf$/, '.interim.pdf');
    fs.writeFileSync(interimPath, bytes);

    // 5b. Remplacement DÉTERMINISTE des balises <entreprise> par le client du DCE, en conservant
    //     police/taille/couleur (≠ réécriture GPT qui ré-insère en Trebuchet). Lancé AVANT l'étape 6
    //     pour retirer le surlignage de la balise → l'étape GPT ne la retouche pas. Opère sur l'interim.
    const ph = this.replacePlaceholdersPython(interimPath, analysisData);

    const hl = this.rewriteHighlightsPython(interimPath, outputPath, analysisData, gssContext, siteNames);
    try { fs.unlinkSync(interimPath); } catch { /* ignore */ }

    // 7. Remplissage des cadres « Zone d'image » par des images générées (OpenAI Images) — DÉSACTIVÉ.
    //    Pour réactiver : décommenter le bloc ci-dessous (et IMAGES_ENABLED / GENERATE_IMAGES).
    // const img = IMAGES_ENABLED
    //   ? this.fillImageZonesPython(outputPath, analysisData, gssContext, siteNames)
    //   : { zones: 0, filled: 0 };
    const img = { zones: 0, filled: 0 };

    console.log(`[MemoireGenerator] Synthèse superposée : ${synthesisChars} car. sur ${zonesUsed} zone(s), ${linesDrawn} ligne(s) dessinée(s)${truncated ? ', surplus tronqué' : ''}, ${refsReplaced} référence(s) client/sites + ${ph.replaced} balise(s) <entreprise> + ${hl.filled}/${hl.regions} passage(s) surligné(s) réécrit(s) + ${img.filled}/${img.zones} cadre(s) image rempli(s) [Python] → ${outputPath}`);

    return {
      filePath: outputPath,
      generatedData: {
        mode: 'AO RNE.pdf + synthèse IA superposée (2 colonnes, design figé)',
        client: clientName,
        zones_remplies: `${zonesUsed}`,
        balises_entreprise: `${ph.replaced}`,
        passages_surlignes: `${hl.filled}/${hl.regions}`,
        cadres_image: `${img.filled}/${img.zones}`,
        texte_genere: `${synthesisChars} caractères`,
      },
    };
  }

  /**
   * Remplacement DÉTERMINISTE des balises <entreprise> (et synonymes : <client>, <société>…) par le
   * nom du client du DCE, via le script Python, en conservant POLICE, TAILLE et COULEUR d'origine et en
   * retirant le surlignage. Opère SUR PLACE (via un fichier temporaire). Étape non bloquante : en cas
   * d'échec, le PDF d'origine est conservé (balises intactes).
   */
  private replacePlaceholdersPython(pdfPath: string, analysisData: any): { replaced: number } {
    const baseDir = path.resolve(__dirname, '../../../../');
    const scriptPath = path.resolve(baseDir, 'gss-ao/backend/python/replace_placeholders.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn(`[MemoireGenerator] Script Python introuvable: ${scriptPath} → balises non remplacées.`);
      return { replaced: 0 };
    }

    const ctx = { clientName: analysisData?.clientName || '' };
    const ctxPath = path.join(this.responseDir, `_phctx_${Date.now()}.json`);
    fs.writeFileSync(ctxPath, JSON.stringify(ctx), 'utf8');
    const tmpOut = pdfPath.replace(/\.pdf$/, '.ph.pdf');

    const pythonBin = process.env.PYTHON_BIN || 'py';
    const proc = spawnSync(
      pythonBin,
      [scriptPath, '--input', pdfPath, '--output', tmpOut, '--context', ctxPath],
      { env: { ...process.env }, encoding: 'utf8', timeout: 120000 },
    );
    try { fs.unlinkSync(ctxPath); } catch { /* ignore */ }

    if (proc.stderr) proc.stderr.split('\n').filter(Boolean).forEach((l) => console.log(`[py-ph] ${l}`));
    if (proc.status !== 0 || !fs.existsSync(tmpOut)) {
      console.warn(`[MemoireGenerator] Script balises échec (status=${proc.status}, err=${proc.error?.message || ''}) → balises conservées.`);
      try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
      return { replaced: 0 };
    }
    try { fs.renameSync(tmpOut, pdfPath); } catch { try { fs.copyFileSync(tmpOut, pdfPath); fs.unlinkSync(tmpOut); } catch { /* ignore */ } }

    try {
      const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
      return { replaced: Number(JSON.parse(line).replaced) || 0 };
    } catch {
      return { replaced: 0 };
    }
  }

  /**
   * Réécriture des passages SURLIGNÉS via le script Python (PyMuPDF → GPT → PyMuPDF). PyMuPDF détecte
   * les surlignages jaunes posés par l'utilisateur DANS le PDF et extrait le texte, GPT réécrit chaque
   * passage adapté au client du DCE, puis PyMuPDF supprime l'ancien texte et insère le nouveau à la
   * même taille. Le contexte client (analyse DCE + atouts GSS) est passé en JSON ; la clé OpenAI et le
   * modèle via l'environnement. En cas d'échec, on recopie le PDF intermédiaire (génération non bloquée).
   */
  private rewriteHighlightsPython(
    inputPdf: string, outputPdf: string, analysisData: any, gssContext: string, sites: string[],
  ): { regions: number; filled: number } {
    const baseDir = path.resolve(__dirname, '../../../../');
    const scriptPath = path.resolve(baseDir, 'gss-ao/backend/python/rewrite_highlights.py');
    const fallback = () => { try { fs.copyFileSync(inputPdf, outputPdf); } catch { /* ignore */ } return { regions: 0, filled: 0 }; };
    if (!fs.existsSync(scriptPath)) {
      console.warn(`[MemoireGenerator] Script Python introuvable: ${scriptPath} → surlignages non traités.`);
      return fallback();
    }

    // Contexte transmis au script (le client/secteur/enjeux servent à personnaliser la réécriture).
    const ctx = {
      clientName: analysisData?.clientName || 'le client',
      sites: (sites || []).filter(Boolean),
      analysis: analysisData ?? {},
      gssContext: (gssContext || '').slice(0, 8000),
    };
    const ctxPath = path.join(this.responseDir, `_hlctx_${Date.now()}.json`);
    fs.writeFileSync(ctxPath, JSON.stringify(ctx), 'utf8');

    const pythonBin = process.env.PYTHON_BIN || 'py';
    const proc = spawnSync(
      pythonBin,
      [scriptPath, '--input', inputPdf, '--output', outputPdf, '--context', ctxPath],
      {
        env: { ...process.env, OPENAI_API_KEY: getSettings().openaiApiKey, MEMOIRE_MODEL: MEMOIRE_MODEL },
        encoding: 'utf8',
        // 600s : marge large pour le page-par-page. Le script s'auto-borne en réalité (REWRITE_TIME_BUDGET)
        // pour toujours finir et retirer le surlignage même si GPT est lent ; ce timeout n'est qu'un garde-fou.
        timeout: 600000,
      },
    );
    try { fs.unlinkSync(ctxPath); } catch { /* ignore */ }

    if (proc.stderr) proc.stderr.split('\n').filter(Boolean).forEach((l) => console.log(`[py] ${l}`));
    if (proc.status !== 0 || !fs.existsSync(outputPdf)) {
      console.warn(`[MemoireGenerator] Script Python échec (status=${proc.status}, err=${proc.error?.message || ''}) → repli sans réécriture.`);
      return fallback();
    }
    try {
      const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
      const r = JSON.parse(line);
      return { regions: Number(r.regions) || 0, filled: Number(r.filled) || 0 };
    } catch {
      return { regions: 0, filled: 0 };
    }
  }

  /**
   * Remplit les cadres « Zone d'image » du PDF par des images GÉNÉRÉES (OpenAI Images) via le script
   * Python (PyMuPDF → OpenAI Images → PyMuPDF). PyMuPDF repère chaque cadre blanc et le contexte texte
   * de la page, OpenAI génère une image photoréaliste adaptée au thème/au client, puis PyMuPDF dessine
   * l'image pour remplir le cadre. Opère SUR PLACE (input = output, via un fichier temporaire). Étape
   * non bloquante : en cas d'échec, le PDF d'origine est conservé (cadres intacts).
   */
  private fillImageZonesPython(
    pdfPath: string, analysisData: any, gssContext: string, sites: string[],
  ): { zones: number; filled: number } {
    const baseDir = path.resolve(__dirname, '../../../../');
    const scriptPath = path.resolve(baseDir, 'gss-ao/backend/python/fill_image_zones.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn(`[MemoireGenerator] Script Python introuvable: ${scriptPath} → cadres image non remplis.`);
      return { zones: 0, filled: 0 };
    }

    const ctx = {
      clientName: analysisData?.clientName || 'le client',
      sites: (sites || []).filter(Boolean),
      analysis: analysisData ?? {},
      gssContext: (gssContext || '').slice(0, 8000),
    };
    const ctxPath = path.join(this.responseDir, `_imgctx_${Date.now()}.json`);
    fs.writeFileSync(ctxPath, JSON.stringify(ctx), 'utf8');
    const tmpOut = pdfPath.replace(/\.pdf$/, '.img.pdf');

    const pythonBin = process.env.PYTHON_BIN || 'py';
    const proc = spawnSync(
      pythonBin,
      [scriptPath, '--input', pdfPath, '--output', tmpOut, '--context', ctxPath],
      {
        env: { ...process.env, OPENAI_API_KEY: getSettings().openaiApiKey, IMAGE_MODEL },
        encoding: 'utf8',
        timeout: 900000, // jusqu'à 15 min : ~11 images générées en parallèle, avec backoff sur 429
      },
    );
    try { fs.unlinkSync(ctxPath); } catch { /* ignore */ }

    if (proc.stderr) proc.stderr.split('\n').filter(Boolean).forEach((l) => console.log(`[py-img] ${l}`));
    if (proc.status !== 0 || !fs.existsSync(tmpOut)) {
      console.warn(`[MemoireGenerator] Script image échec (status=${proc.status}, err=${proc.error?.message || ''}) → cadres conservés.`);
      try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
      return { zones: 0, filled: 0 };
    }
    // Remplace le PDF par la version avec images (in-place).
    try { fs.renameSync(tmpOut, pdfPath); } catch { try { fs.copyFileSync(tmpOut, pdfPath); fs.unlinkSync(tmpOut); } catch { /* ignore */ } }

    try {
      const line = (proc.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
      const r = JSON.parse(line);
      return { zones: Number(r.zones) || 0, filled: Number(r.filled) || 0 };
    } catch {
      return { zones: 0, filled: 0 };
    }
  }

  /** Récupère client / titre / référence pour la page de garde (base puis analyse DCE). */
  private async getCoverInfo(dossierId: string): Promise<{ client: string; title: string; ref: string }> {
    const fallback = { client: 'GSS — Global Security Service', title: 'Mémoire technique', ref: '' };
    if (!dossierId || dossierId === 'export') return fallback;
    try {
      const dossier = DB.getDossier(dossierId);
      if (dossier && (dossier.acheteur || dossier.reference || dossier.objet)) {
        return {
          client: dossier.acheteur || fallback.client,
          title: dossier.objet || fallback.title,
          ref: dossier.reference || '',
        };
      }
      const analysis = await this.analyzeDce(await this.getDceContext(dossierId));
      return {
        client: analysis?.clientName || fallback.client,
        title: analysis?.projectTitle || fallback.title,
        ref: analysis?.marketRef || '',
      };
    } catch (e: any) {
      console.warn(`[MemoireGenerator] Infos page de garde indisponibles: ${e.message}`);
      return fallback;
    }
  }

  /** Page de garde : label vert, gros titre blanc, client crème, référence. */
  private buildCoverXml(cover: { client: string; title: string; ref: string }): string {
    const spacer = () => paraX('', { after: 0 });
    const parts: string[] = [];
    for (let i = 0; i < 6; i++) parts.push(spacer());
    parts.push(paraX(runX('MÉMOIRE TECHNIQUE', { bold: true, size: 28, color: COL_ACCENT }), { align: 'center', after: 200 }));
    parts.push(paraX(runX((cover.title || '').toUpperCase(), { bold: true, size: 52, color: COL_TITLE }), { align: 'center', after: 240 }));
    parts.push(paraX(runX(cover.client || '', { bold: true, size: 32, color: COL_BODY }), { align: 'center', after: 120 }));
    if (cover.ref) parts.push(paraX(runX(cover.ref, { size: 24, color: COL_MUTED }), { align: 'center', after: 120 }));
    for (let i = 0; i < 4; i++) parts.push(spacer());
    parts.push(paraX(runX('GSS — Global Security Service', { bold: true, size: 24, color: COL_ACCENT }), { align: 'center', after: 0 }));
    return parts.join('');
  }

  /**
   * Export DOCX du cas "sans cadre imposé" (Mode B) tel que GSS-MT-Generator :
   * on reçoit la map plate des sections générées côté front ({id: texte}),
   * on la regroupe par chapitre via le mapping AI_SECTIONS_B, puis on assemble
   * le mémoire de référence GSS via assembleFromSections. Renvoie le chemin du
   * .docx produit (à streamer en téléchargement par la route /export-docx).
   */
  public async exportFromSectionsMap(
    sectionsMap: Record<string, string>,
  ): Promise<{ filePath: string; generatedData: Record<string, string> }> {
    const chapters: AssembleChapter[] = CHAPTER_ORDER_B.map((ch) => ({
      key: ch,
      title: CHAPTER_TITLES_B[ch],
      sections: AI_SECTIONS_B
        .filter((s) => s.chapter === ch && sectionsMap[s.id]?.trim())
        .map((s) => ({ title: s.title, text: sectionsMap[s.id] })),
    }));

    if (chapters.every((c) => c.sections.length === 0)) {
      throw new Error('Aucune section générée à exporter (map vide ou ids inconnus).');
    }

    return this.assembleFromSections('export', chapters);
  }
}
