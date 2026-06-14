import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';
import OpenAI from 'openai';
import { getSettings } from '../core/config';
import { DB } from '../core/db';
import { extractText } from '../ingestion/docConverter';
// @ts-ignore
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { hasUncaughtExceptionCaptureCallback } from 'process';

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

// ─── Construction d'un mémoire PROPRE (XML en chaîne, zéro DOM) ───
// On ne touche plus jamais au DOM d'AO RNE (le re-sérialiser dégrade sa maquette).
// À la place, on génère un document.xml NEUF, dont le rendu reprend une identité
// visuelle GSS épurée : fond gris uniforme clair, texte foncé lisible, accent rouge GSS.

// ─── Refonte V1 du template (fond gris uniforme + thème clair) ───
// Le fond de page (Word: <w:background>). Gris clair lisible, configurable.
// Repli possible sur 'FFFFFF' si un rendu Word pose problème (cf. garde-fou).
const BACKGROUND_COLOR = 'E5E5E5';   // gris clair uniforme

// Palette « thème clair » : texte foncé sur fond gris clair (lisibilité garantie).
const COL_BG = BACKGROUND_COLOR; // fond de page (gris clair)
const COL_TITLE = '1A1A1A';      // titres (quasi-noir)
const COL_BODY = '2B2B2B';       // corps de texte (gris très foncé)
const COL_ACCENT = 'C81E1E';     // rouge GSS (filets / labels)
const COL_MUTED = '595959';      // gris moyen (sous-texte)

// Bandeau d'en-tête à conserver (image GSS porteuse du titre dans AO RNE.docx = image2.png).
const HEADER_IMAGE_NAME = 'image2.png';
const HEADER_REL_ID = 'rIdHdrGss';   // Id de la relation document→header (unique)

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
   * Adapte les textes statiques d'un mémoire GSS maître (rédigé pour un marché passé) au nouveau
   * marché : remplace l'ancien nom de client, l'ancienne référence de marché et les anciens noms
   * de sites par les valeurs issues de l'analyse. N'agit que sur les `<w:t>` (texte affiché).
   */
  private adaptStaticText(xmlDoc: any, analysisData: any) {
    const clientName: string = analysisData?.clientName || '';
    const marketRef: string = analysisData?.marketRef || analysisData?.projectTitle || '';
    const sites: Array<{ name?: string }> = analysisData?.sites || [];
    if (!clientName && !marketRef && sites.length === 0) return;

    // Termes du marché passé (le maître AO RNE.docx était un mémoire Université de Rouen MP2026-08)
    const oldClient = [/Université de Rouen Normandie/g, /l['’]Université de Rouen Normandie/g, /Université de Rouen/g];
    const oldRef = [/MP\s*n°\s*2026-08/g, /2026-08/g];
    const oldSites: Array<[RegExp, number]> = [
      [/Campus Mont-Saint-Aignan\s*\+\s*INSPE/gi, 0], [/Campus Mont-Saint-Aignan/gi, 0],
      [/Campus Martainville\s*\(UFR Santé\)/gi, 1], [/Campus Martainville/gi, 1],
      [/Campus Pasteur\s*\(UFR DESP\)/gi, 2], [/Campus Pasteur/gi, 2],
      [/Campus du Madrillet/gi, 3],
      [/Campus Evreux Tilly-Navarre/gi, 4], [/Campus Evreux/gi, 4],
    ];

    let count = 0;
    getElementsWithLocalName(xmlDoc, 't').forEach((tEl: any) => {
      let text = tEl.textContent || '';
      if (!text) return;
      const before = text;
      if (clientName) oldClient.forEach(re => { text = text.replace(re, clientName); });
      if (marketRef) oldRef.forEach(re => { text = text.replace(re, marketRef); });
      oldSites.forEach(([re, idx]) => {
        const name = sites[idx]?.name;
        if (name) text = text.replace(re, name);
      });
      if (text !== before) { tEl.textContent = text; count++; }
    });
    console.log(`[MemoireGenerator] Adaptation mémoire maître: ${count} segment(s) de texte mis à jour.`);
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
   * Cas "sans cadre imposé" (mode B / réponse libre). On NE touche PAS au DOM d'AO RNE
   * (le re-sérialiser dégrade sa maquette, et son identité est gravée dans des images
   * donc non personnalisable en texte). À la place on CONSTRUIT un document NEUF et
   * propre, dont le rendu reprend une identité GSS épurée (refonte V1 :
   * fond gris uniforme clair, texte foncé lisible, accent rouge GSS, bandeau d'en-tête
   * GSS conservé et répété sur chaque page, images décoratives retirées), rempli avec le
   * contenu généré (DCE + doc GSS) et personnalisé via la page de garde (client / référence).
   *
   * `options.noTemplate` : produit à la place un DOCX NU (aucun ZIP de référence,
   * styles Word par défaut, ni fond, ni en-tête, ni page de garde) — utilisé pour la
   * comparaison « avec template refondu » vs « sans template ».
   */
  public async assembleFromSections(
    dossierId: string,
    chapters: AssembleChapter[],
    options: { noTemplate?: boolean } = {},
  ): Promise<{ filePath: string; generatedData: Record<string, string> }> {
    if (options.noTemplate) {
      return this.assembleNoTemplate(chapters);
    }

    // 1. Infos d'en-tête (page de garde) : base si renseignée, sinon analyse du DCE.
    const cover = await this.getCoverInfo(dossierId);

    // 2. Construire le corps : page de garde + chapitres/sections.
    const bodyParts: string[] = [];
    bodyParts.push(this.buildCoverXml(cover));

    let chaptersOut = 0;
    let sectionsOut = 0;
    chapters.forEach((chapter, idx) => {
      if (!chapter || !chapter.sections || chapter.sections.length === 0) return;
      // Titre de chapitre (page neuve + filet vert).
      const roman = chapter.key || ['I', 'II', 'III', 'IV', 'V', 'VI'][idx] || String(idx + 1);
      bodyParts.push(
        paraX(runX(`${roman}.  ${chapter.title || ''}`.trim().toUpperCase(), { bold: true, size: SZ_CHAPTER, color: COL_TITLE }),
          { pageBreak: chaptersOut > 0, before: 240, after: 200, accentRule: true }),
      );
      for (const sec of chapter.sections) {
        const title = sec.title?.trim();
        if (title) {
          bodyParts.push(paraX(runX(title, { bold: true, size: SZ_SECTION, color: COL_ACCENT }), { before: 280, after: 140 }));
        }
        bodyParts.push(markdownToParagraphsX(sec.text, title));
        sectionsOut++;
      }
      chaptersOut++;
    });

    if (chaptersOut === 0) {
      throw new Error('Aucun chapitre généré à exporter (sections vides).');
    }

    // 3. Section finale : format A4 d'AO RNE, marges propres + référence d'en-tête
    //    (le bandeau GSS se répète ainsi sur chaque page).
    const sectPr =
      '<w:sectPr>' +
      `<w:headerReference w:type="default" r:id="${HEADER_REL_ID}"/>` +
      '<w:pgSz w:w="11910" w:h="16850"/>' +
      '<w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="0" w:gutter="0"/>' +
      '</w:sectPr>';

    // xmlns:r requis pour la référence d'en-tête (r:id).
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<w:background w:color="${COL_BG}"/>` +
      `<w:body>${bodyParts.join('')}${sectPr}</w:body></w:document>`;

    // 4. Repartir du zip AO RNE (styles/polices/thème valides) mais réécrire document.xml,
    //    activer l'affichage du fond, conserver UNIQUEMENT le bandeau d'en-tête GSS
    //    (image2.png) et retirer les ~220 images décoratives des pages dupliquées.
    const templatePath = path.join(this.templateDir, 'Mémoire technique', 'AO RNE.docx');
    if (!fs.existsSync(templatePath)) throw new Error(`Template de référence introuvable : ${templatePath}`);
    const zip = new PizZip(fs.readFileSync(templatePath));
    zip.file('word/document.xml', documentXml);

    // Affichage du fond de page (sinon <w:background> est ignoré par Word).
    const settings = zip.file('word/settings.xml');
    if (settings) {
      let s = settings.asText();
      if (!/displayBackgroundShape/.test(s)) {
        s = s.replace(/(<w:settings[^>]*>)/, '$1<w:displayBackgroundShape/>');
        zip.file('word/settings.xml', s);
      }
    }

    // 4a. Retirer TOUTES les images décoratives sauf le bandeau d'en-tête (image dupliquée
    //     sur les pages = inutile dans une génération propre). On garde le fichier media
    //     dans le .docx source (revert), mais on ne le référence plus.
    let removedMedia = 0;
    Object.keys(zip.files)
      .filter((n) => n.startsWith('word/media/') && n !== `word/media/${HEADER_IMAGE_NAME}`)
      .forEach((n) => { delete (zip as any).files[n]; removedMedia++; });
    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
      // Le nouveau document.xml ne référence aucun média : on purge toutes les relations média.
      const rels = relsFile.asText().replace(/<Relationship\b[^>]*Target="media\/[^"]*"[^>]*\/>/g, '');
      zip.file('word/_rels/document.xml.rels', rels);
    }

    // 4b. En-tête : créer word/header1.xml (bandeau GSS), sa relation vers image2.png,
    //     l'override de type de contenu, et la relation header dans document.xml.rels.
    this.injectHeader(zip);

    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const outputFileName = `Mémoire technique GSS_${Date.now()}.docx`;
    const outputPath = path.join(this.responseDir, outputFileName);
    fs.writeFileSync(outputPath, buf);

    console.log(`[MemoireGenerator] Mémoire propre généré (fond gris ${COL_BG}, header conservé, ${removedMedia} média(s) retiré(s)) : ${chaptersOut} chapitre(s), ${sectionsOut} section(s) → ${outputPath}`);

    return {
      filePath: outputPath,
      generatedData: {
        mode: `Document propre refondu (fond gris uniforme #${COL_BG}, bandeau GSS conservé)`,
        chapitres: String(chaptersOut),
        sections: String(sectionsOut),
        medias_retires: String(removedMedia),
      },
    };
  }

  /**
   * Injecte un en-tête (word/header1.xml) affichant le bandeau GSS (image2.png),
   * répété sur chaque page via le headerReference du sectPr. Crée la relation
   * header→image, l'override [Content_Types] et la relation document→header.
   */
  private injectHeader(zip: PizZip): void {
    // Bandeau GSS inline, centré. Ratio d'origine 3134906×1229188 (≈ 2,55:1).
    const cx = 2200000;
    const cy = Math.round(cx * (1229188 / 3134906)); // conserve le ratio
    const headerXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      '<wp:docPr id="900" name="BandeauGSS"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="900" name="BandeauGSS"/><pic:cNvPicPr/></pic:nvPicPr>' +
      `<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
      '</a:graphicData></a:graphic></wp:inline>' +
      '</w:drawing></w:r></w:p></w:hdr>';
    zip.file('word/header1.xml', headerXml);

    // Relation header → image bandeau.
    zip.file('word/_rels/header1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${HEADER_IMAGE_NAME}"/>` +
      '</Relationships>');

    // Relation document → header (l'Id doit correspondre au headerReference du sectPr).
    const docRels = zip.file('word/_rels/document.xml.rels');
    if (docRels) {
      let r = docRels.asText();
      if (!r.includes(HEADER_REL_ID)) {
        r = r.replace(/<\/Relationships>\s*$/,
          `<Relationship Id="${HEADER_REL_ID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`);
        zip.file('word/_rels/document.xml.rels', r);
      }
    }

    // Override [Content_Types] pour header1.xml.
    const ct = zip.file('[Content_Types].xml');
    if (ct) {
      let c = ct.asText();
      if (!c.includes('header1.xml')) {
        c = c.replace(/<\/Types>\s*$/,
          '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>');
        zip.file('[Content_Types].xml', c);
      }
    }
  }

  /**
   * Construit un DOCX NU (sans cadre, sans ZIP de référence) : styles Word par défaut,
   * aucun fond de page, aucun en-tête/pied, aucune page de garde. Sert de point de
   * comparaison « génération sans template » face au template refondu.
   */
  private async assembleNoTemplate(
    chapters: AssembleChapter[],
  ): Promise<{ filePath: string; generatedData: Record<string, string> }> {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const esc = (s: string) => escXml(s);
    // Rendu minimaliste : titres en gras (pas de styles Heading), corps en texte brut.
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
      `<w:document xmlns:w="${W}"><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

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
