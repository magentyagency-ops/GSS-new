import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';
import OpenAI from 'openai';
import { getSettings } from '../core/config';
import { DB } from '../core/db';
import { extractText } from '../ingestion/docConverter';
// @ts-ignore
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// Modèle utilisé pour la génération. gpt-4o-mini a une limite TPM bien plus élevée (200k vs 30k
// pour gpt-4o sur ce compte) → génération rapide sans throttling. Surchargeable par env.
const MEMOIRE_MODEL = process.env.MEMOIRE_MODEL || 'gpt-4o-mini';

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

/** Remplace le texte de toutes les zones de titre (txbxContent) de la section par `title`. */
function setSectionHeading(paras: any[], title: string) {
  paras.forEach(p => {
    getElementsWithLocalName(p, 'txbxContent').forEach((tx: any) => {
      const tEls = getElementsWithLocalName(tx, 't');
      if (tEls.length === 0) return;
      tEls[0].textContent = title;
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

// Fix V1.1 — image décorative "agent + chien berger allemand" à retirer (page I. PRESENTATION).
const DOG_IMAGE = 'image8.jpeg';

/** Résout les rIds d'une cible média donnée depuis le XML de relations. */
function ridsForMedia(relsXml: string, mediaName: string): string[] {
  const re = new RegExp(`Id="(rId\\d+)"[^>]*Target="media/${mediaName.replace(/\./g, '\\.')}"`, 'g');
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Fix V1.1 — retire du document le bloc décoratif "agent + chien" : pour chaque référence
 * (DrawingML `r:embed` ou VML `r:id`) à l'une des `dogRids`, remonte au `<w:r>` englobant
 * et le supprime (ce run contient le `mc:AlternateContent` du bloc chien). Renvoie le
 * nombre de runs retirés. N'affecte que les images listées dans `dogRids`.
 */
function removeDogImageReferences(doc: any, dogRids: string[]): number {
  if (!dogRids.length) return 0;
  const ridSet = new Set(dogRids);
  const runsToRemove = new Set<any>();
  const scan = (localName: string, attr: string) => {
    getElementsWithLocalName(doc.documentElement, localName).forEach((el: any) => {
      const id = el.getAttribute(attr);
      if (id && ridSet.has(id)) {
        const run = getParentWithLocalName(el, 'r');
        if (run) runsToRemove.add(run);
      }
    });
  };
  scan('blip', 'r:embed');       // DrawingML (mc:Choice)
  scan('imagedata', 'r:id');     // VML (mc:Fallback)
  let removed = 0;
  runsToRemove.forEach((run: any) => { if (run.parentNode) { run.parentNode.removeChild(run); removed++; } });
  return removed;
}

/**
 * Refonte V1 — sur une page DUPLIQUÉE, retire les images de fond pleine page
 * "inutiles" (anchors `behindDoc="1"` porteurs d'une photo) afin de laisser
 * apparaître le fond gris uniforme. On NE retire QUE les runs qui ne contiennent
 * PAS de zone de titre (`txbxContent`) : le bandeau d'en-tête / titre est toujours
 * conservé. Renvoie le nombre de runs-images retirés.
 */
function stripStandaloneBgImages(paras: any[]): number {
  let removed = 0;
  paras.forEach((p) => {
    const runs = getElementsWithLocalName(p, 'r');
    runs.forEach((r: any) => {
      const anchors = getElementsWithLocalName(r, 'anchor');
      const isFullPageBg = anchors.some((a: any) => a.getAttribute('behindDoc') === '1');
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

/**
 * Force la couleur des runs (texte) d'un sous-arbre — lisibilité sur fond gris.
 * Fix V1.1 : on ÉPARGNE les bandeaux de titre (`txbxContent`, ex. "NOS AGENTS …",
 * "I. PRESENTATION") dont le fond est foncé : y forcer un texte sombre le rendrait
 * invisible. Le corps (hors `txbxContent`) reste forcé en sombre pour rester lisible.
 */
function forceTextColor(paras: any[], color: string) {
  paras.forEach((p) => {
    getElementsWithLocalName(p, 'r').forEach((r: any) => {
      // ne pas toucher aux runs purement graphiques (drawing/pict) sans texte
      if (getElementsWithLocalName(r, 't').length === 0) return;
      // bandeau de titre → conserver la couleur claire d'origine (lisible sur fond foncé)
      if (getParentWithLocalName(r, 'txbxContent')) return;
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
2. Les besoins en agents (effectifs en ETP, profils : CQP APS, SSIAP 1/2/3, encadrement) et le taux de reprise du personnel en place (annexes).
3. Les contraintes matérielles (contrôle de rondes, pointeaux, PTI/DATI, tenues, véhicules).
4. L'obligation de visite (RC) croisée avec le rapport de visite.
5. Des "Arguments Différenciants" (forces de GSS) et des "Problématiques Anticipées" (risques techniques/humains non formulés par l'acheteur + la solution GSS associée).

Tu renvoies un objet JSON valide et exhaustif.`;

    const userPrompt = `Voici les documents du DCE (CCTP, RC, rapport de visite, annexes) :
${dceContext.slice(0, 120_000)}

Génère une réponse JSON valide respectant EXACTEMENT cette structure :
{
  "clientName": "Nom exact du donneur d'ordre (ex: Université de Rouen Normandie)",
  "projectTitle": "Intitulé complet du marché",
  "marketRef": "Référence du marché (ex: MP n°2026-08)",
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
  "anticipatedIssues": [ "Problématique non formulée par l'acheteur + solution concrète GSS" ]
}`;

    const content = await this.callOpenAI(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      0.2, 'Analyse DCE', true,
    );
    try {
      const data = JSON.parse(content || '{}');
      console.log(`[MemoireGenerator] Analyse DCE: client="${data.clientName || '?'}", ${(data.sites || []).length} site(s), ${(data.anticipatedIssues || []).length} problématique(s) anticipée(s).`);
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

    // ── Sans cadre imposé : générer un mémoire complet via AO RNE personnalisé ──
    if (!isClientTemplate) {
      return this.generateFullMemoire(dossierId);
    }

    // 2. Analyse structurée du DCE (contexte unique de rédaction), avant toute manipulation du Word
    const dceContext = await this.getDceContext(dossierId);
    const analysisData = await this.analyzeDce(dceContext);
    const analysisJson = JSON.stringify(analysisData, null, 2);

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
            cellInfos.forEach((cInfo: any) => {
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
On te fournit l'ANALYSE stratégique et opérationnelle du marché (client, sites, exigences, rapport de visite de Sacha, arguments différenciants de GSS, problématiques terrain anticipées) et une liste de champs [CHAMP_X] repérés dans le cadre de réponse de l'acheteur. Tu rédiges la valeur à insérer dans chacun.

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
[PARAGRAPHE]      → paragraphe dense, technique et engageant (3 à 8 phrases développées) qui VEND GSS. Jamais de réponse paresseuse ("Conforme", "Disponible", "Oui").
[CASE A COCHER]   → UNIQUEMENT "☑" (GSS se conforme à 100%) ou "☐".
JAMAIS de markdown (pas de **gras**, pas de #). Sauts de ligne et tirets simples uniquement.

══════════════════════════════════════
RÈGLE N°2 — PERSONNALISATION (ce qui fait gagner)
══════════════════════════════════════
- Utilise le nom exact du client, des sites et le contexte de l'analyse pour un texte totalement sur-mesure.
- Exploite les observations de la visite terrain (visitDetails) pour prouver notre connaissance du site.
- Intègre les "proposalStrengths" et les "anticipatedIssues" (avec leur solution GSS) au cœur des [PARAGRAPHE], pour montrer que GSS anticipe des risques non formulés dans le CCTP.
- Décris concrètement : organisation, contrôle CNAPS, gestion des plannings, rondes/pointeaux NFC, PTI/DATI, gestion des alarmes, remplacement d'agents.

══════════════════════════════════════
RÈGLE N°3 — DONNÉES LÉGALES : NE JAMAIS INVENTER
══════════════════════════════════════
Pour tout champ d'identité légale (SIRET, N° CNAPS, NOM du dirigeant, n° d'agrément dirigeant, dates
d'obtention/validité, n° de certification, adresses, coordonnées/téléphone/email) : n'utilise QUE des
valeurs présentes dans l'analyse/DCE. Sinon écris EXACTEMENT "[À COMPLÉTER]" (rien d'autre, pas de nom
inventé type "Jean Dupont"). N'invente JAMAIS un nom, un numéro, une date, une adresse ou un contact.

FORMAT DE RÉPONSE : JSON valide uniquement → {"replacements": [ {"id": 1, "value": "..."} ]}`;

    // 5. Traitement par lots. gpt-4o-mini (200k TPM) permet des lots plus gros → moins d'allers-retours.
    const BATCH_SIZE = 20;
    const replacements: Array<{ id: number; value: string }> = [];

    /** Appelle le modèle sur un sous-ensemble de champs et collecte les valeurs renvoyées. */
    const runBatch = async (batchFields: FieldDesc[], label: string): Promise<void> => {
      if (batchFields.length === 0) return;
      const batchPrompts = batchFields.map(buildPrompt);
      const hasParagraph = batchPrompts.some(p => p.includes('[PARAGRAPHE]'));
      const temperature = hasParagraph ? 0.4 : 0.2;

      const userPrompt = `Analyse du marché public (contexte unique de rédaction) :
${analysisJson}

Liste des ${batchPrompts.length} champs à remplir (${label}) :
${batchPrompts.join('\n')}

Renvoie uniquement un objet JSON valide contenant les ${batchPrompts.length} valeurs. CHAQUE champ listé ci-dessus doit être présent dans la réponse.`;

      const approxTokens = Math.round((systemPrompt.length + userPrompt.length) / 4);
      console.log(`[MemoireGenerator] ${label}: ${batchPrompts.length} champs, temp=${temperature}, ~${approxTokens} tokens`);
      const aiResponse = await this.callOpenAI(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature, label, true,
      );
      if (aiResponse === null) return;
      try {
        const data = JSON.parse(aiResponse || '{}');
        const batchResults: Array<{ id: number; value: string }> = data.replacements || [];
        replacements.push(...batchResults);
        console.log(`[MemoireGenerator] ${label}: ${batchResults.length} valeurs renvoyées.`);
      } catch (e) {
        console.error(`[MemoireGenerator] ${label}: parse JSON échoué:`, (aiResponse || '').slice(0, 200));
      }
    };

    const totalBatches = Math.ceil(descriptors.length / BATCH_SIZE);
    console.log(`[MemoireGenerator] Traitement de ${descriptors.length} champs en ${totalBatches} lot(s) parallèles...`);
    // Lots indépendants lancés en parallèle (200k TPM / 10k RPM le permettent largement).
    await Promise.all(
      Array.from({ length: totalBatches }, (_, i) =>
        runBatch(descriptors.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE), `Lot ${i + 1}/${totalBatches}`)
      )
    );

    // Passe de complétion : rattrape les champs sans valeur (lot ayant échoué ou oubli du modèle)
    const answeredIds = new Set(replacements.map(r => r.id));
    const missing = descriptors.filter(d => !answeredIds.has(d.id));
    if (missing.length > 0) {
      console.log(`[MemoireGenerator] Passe de complétion : ${missing.length} champ(s) manquant(s).`);
      const nComp = Math.ceil(missing.length / BATCH_SIZE);
      await Promise.all(
        Array.from({ length: nComp }, (_, i) =>
          runBatch(missing.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE), `Complétion ${i + 1}`)
        )
      );
    }

    console.log(`[MemoireGenerator] GPT a renvoyé ${replacements.length} valeurs au total.`);

    // Garde-fou anti-invention : pour les champs légaux (SIRET, CNAPS, agrément, dates
    // d'autorisation, adresses), toute valeur dont les chiffres n'apparaissent pas dans les
    // sources réelles est remplacée par [À COMPLÉTER]. Indépendant du modèle (mini invente parfois).
    const sourceDigits = (analysisJson + ' ' + dceContext).replace(/\D/g, '');
    const isLegalField = (ctx: string) => /siret|cnaps|n. d.autorisation|numero d.autorisation|agrement dirigeant|date d.obtention|date de validite|adresse du siege|adresse de l.agence/.test(normCtx(ctx));
    const guardLegal = (val: string, ctx: string): string => {
      if (!isLegalField(ctx)) return val;
      const digitRuns = val.match(/\d{3,}/g) || [];
      const unverified = digitRuns.some(d => !sourceDigits.includes(d));
      if (unverified) {
        console.log(`[MemoireGenerator] Garde-fou: valeur légale non vérifiée → [À COMPLÉTER] (ctx: ${ctx.slice(0, 60)})`);
        return '[À COMPLÉTER]';
      }
      return val;
    };

    // 6. Apply replacements in the DOM
    let applied = 0;
    replacements.forEach((rep: any) => {
      const desc = descriptors.find(d => d.id === rep.id);
      if (!desc) return;
      const value = guardLegal(String(rep.value), desc.context);
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

      // Fix V1.1 — retirer l'image décorative "agent + chien" (image8.jpeg) : références
      // dans document.xml, puis relation orpheline + fichier média (gain de poids).
      const docRelsFile = zip.file('word/_rels/document.xml.rels');
      const dogRids = docRelsFile ? ridsForMedia(docRelsFile.asText(), DOG_IMAGE) : [];
      const dogRefsRemoved = removeDogImageReferences(xmlDoc, dogRids);
      if (dogRefsRemoved > 0 && docRelsFile) {
        let r = docRelsFile.asText();
        dogRids.forEach((rid) => {
          r = r.replace(new RegExp(`<Relationship Id="${rid}"[^>]*/>`, 'g'), '');
        });
        zip.file('word/_rels/document.xml.rels', r);
        const dogFile = `word/media/${DOG_IMAGE}`;
        if (zip.file(dogFile)) delete (zip as any).files[dogFile];
      }
      console.log(`[MemoireGenerator] Fix V1.1 : image chien (${DOG_IMAGE}) — ${dogRefsRemoved} référence(s) retirée(s) [rIds: ${dogRids.join(', ') || 'aucun'}].`);
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
    let inserted = 0;
    flat.forEach((sec, idx) => {
      let best = spreads[idx % spreads.length];
      let bestScore = 0;
      spreads.forEach((sp) => { const sc = scoreMatch(sec.title, sp.headingText); if (sc > bestScore) { bestScore = sc; best = sp; } });

      const newNodes = cloneSpread(xmlDoc, best.headingParas, best.bodyParas, counter, sec.title, sec.text, refonte, stats);
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
   * Trouve les catégories de Documentation GSS pertinentes pour un titre de spread donné,
   * par correspondance de mots-clés dans GSS_DOC_KEYWORDS.
   */
  private matchGssCategories(spreadTitle: string, availableCategories: string[]): string[] {
    const n = normTitle(spreadTitle);
    const matches: string[] = [];

    for (const [cat, keywords] of Object.entries(GSS_DOC_KEYWORDS)) {
      if (!availableCategories.includes(cat)) continue;
      if (keywords.some(kw => n.includes(kw))) matches.push(cat);
    }

    // Fallback : correspondance par mots du titre dans les noms de catégories
    if (matches.length === 0) {
      const words = n.split(' ').filter(w => w.length > 3);
      for (const cat of availableCategories) {
        const catNorm = normTitle(cat);
        if (words.some(w => catNorm.includes(w))) matches.push(cat);
      }
    }

    return matches.slice(0, 4); // 4 catégories max par section
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

    // ── 5. Découper le document en sections pour isoler les spreads ──
    const body = findLocalNameChild(xmlDoc.documentElement, 'body');
    if (!body) throw new Error('<w:body> introuvable dans AO RNE.docx');
    const { sections } = splitBodyIntoSections(body);

    const allSpreads: any[] = [];
    for (let i = 0; i < sections.length - 1; i++) {
      if (
        sectionHasBackgroundImage(sections[i]) &&
        sectionHasTextbox(sections[i]) &&
        sectionIsPlainText(sections[i + 1])
      ) {
        allSpreads.push({ headingParas: sections[i], bodyParas: sections[i + 1] });
      }
    }
    if (allSpreads.length < 2) throw new Error('Pas assez de spreads dans AO RNE pour cloner.');

    // ── 6. Génération IA de la synthèse personnalisée (1 seule génération ciblée) ──
    console.log(`[MemoireGenerator] Génération IA de la synthèse personnalisée pour ${clientName}...`);
    const systemPrompt = `Tu es un expert en sécurité privée chez GSS. Rédige une "Synthèse de l'offre" complète (800-1200 mots) qui sera ajoutée en introduction du mémoire technique.
- Basé UNIQUEMENT sur l'analyse du DCE et les atouts GSS.
- Personnalise un maximum pour le client : nom, sites, enjeux, risques anticipés.
- Mets en avant l'accompagnement GSS (interlocuteur unique, qualité, réactivité).
- Rédige une dizaine de paragraphes bien développés.
- IMPORTANT : N'utilise AUCUNE liste à puces (aucun tiret, aucun bullet point, aucun symbole). Rédige UNIQUEMENT sous forme de texte continu en paragraphes complets. Pas de markdown.
- Le ton doit être professionnel, rassurant et très commercial (vendre l'offre).`;

    const userPrompt = `ANALYSE DU MARCHÉ (DCE) :\n${analysisJson}\n\nATOUTS GSS (Extrait doc) :\n${gssContext}\n\nRédige le texte de la synthèse de notre offre sur mesure pour ce client.`;

    const generatedText = await this.callOpenAI(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      0.5, 'Génération Synthèse', false
    );

    if (!generatedText) throw new Error('Échec de la génération IA de la synthèse.');

    // ── 7. Cloner le spread pour chaque bloc de 4 paragraphes ──
    // L'image de fond grise est ancrée dans l'en-tête du spread. Si le texte est
    // trop long, il bave sur une page blanche. Pour avoir le fond gris partout,
    // on découpe le texte et on duplique le spread complet pour chaque bloc de texte.
    const counter = { v: maxDrawingId(xmlDoc) };
    
    // Le client veut le "grand fond gris" complet. Ce grand fond se trouve
    // généralement sur la première page (couverture, index 0).
    // On va donc utiliser l'image de fond du spread 0, mais conserver 
    // le style de texte standard du spread 1 pour le contenu.
    const modelSpread = {
      headingParas: allSpreads[0].headingParas,
      bodyParas: allSpreads[1].bodyParas
    };
    
    const title = 'Notre offre sur mesure';
    
    const allLines = bodyTextToLines(generatedText);
    const PARAS_PER_PAGE = 4;
    
    // On insère juste après le corps du 1er spread
    const coverSpreadLastPara = allSpreads[0].bodyParas[allSpreads[0].bodyParas.length - 1];
    let refNode = coverSpreadLastPara.nextSibling;
    
    for (let i = 0; i < allLines.length; i += PARAS_PER_PAGE) {
      const chunkLines = allLines.slice(i, i + PARAS_PER_PAGE).join('\n');
      const newNodes = cloneSpread(
        xmlDoc, modelSpread.headingParas, modelSpread.bodyParas,
        counter, title, chunkLines
      );
      
      newNodes.forEach(n => {
         body.insertBefore(n, refNode);
      });
    }

    console.log(`[MemoireGenerator] Synthèse ajoutée avec succès (${generatedText.length} caractères).`);

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
