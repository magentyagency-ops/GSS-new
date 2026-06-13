import { SourceMeta, ExtractionMethod } from '../schemas/common';
import { CCTPDocument, SectionCCTP, Prestation, ExigenceAgent, TypePrestation, CategorieExigence } from '../schemas/cctp';
import { loadDocxStructure } from '../ingestion/docConverter';

const HEADING_RE = /^(?:Heading|Titre)\s*(\d+)$/i;

function headingLevel(styleName: string | null): number | null {
  if (!styleName) return null;
  const m = HEADING_RE.exec(styleName.replace(/\s+/g, ''));
  return m ? parseInt(m[1], 10) : null;
}

const LOT_RE = /lot\s*(\d+)/i;
const DEPT_TO_LOT: Record<string, number> = { '76': 1, '27': 2 };

const KW_TELESECU = ['télé-sécurité', 'télésécurité', 'télé sécurité', 'telesecurite'];
const KW_SUPPL = ['supplémentaire', 'supplementaire', 'à la demande', 'a la demande'];
const KW_BASE = ['de base', '« de base »', 'prestations de base'];

const QUALIF_TOKENS = [
  'SSIAP2', 'SSIAP 2', 'SSIAP1', 'SSIAP 1', 'APS', 'ADS', 'AMC',
  'CNAPS', 'carte professionnelle', 'recyclage', 'H0B0', 'HOB0', 'SST', 'PSC1',
];

const EXIGENCE_TITLE_MAP: [string, CategorieExigence][] = [
  ['qualification', CategorieExigence.QUALIFICATION],
  ['recyclage', CategorieExigence.QUALIFICATION],
  ['tenue', CategorieExigence.TENUE],
  ['équipement', CategorieExigence.EQUIPEMENT],
  ['equipement', CategorieExigence.EQUIPEMENT],
  ['véhicule', CategorieExigence.VEHICULE],
  ['vehicule', CategorieExigence.VEHICULE],
  ['comportement', CategorieExigence.COMPORTEMENT],
  ['présentation', CategorieExigence.COMPORTEMENT],
  ['presentation', CategorieExigence.COMPORTEMENT],
];

function classifyPrestationType(title: string): TypePrestation | null {
  const low = title.toLowerCase();
  if (KW_TELESECU.some(k => low.includes(k))) return TypePrestation.TELESECURITE;
  if (KW_SUPPL.some(k => low.includes(k))) return TypePrestation.SUPPLEMENTAIRE;
  if (KW_BASE.some(k => low.includes(k))) return TypePrestation.BASE;
  return null;
}

function detectLot(title: string): number | null {
  const m = LOT_RE.exec(title);
  if (m) return parseInt(m[1], 10);
  for (const [dept, lot] of Object.entries(DEPT_TO_LOT)) {
    if (title.includes(dept)) return lot;
  }
  return null;
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function buildTree(filePath: string): { roots: SectionCCTP[]; flat: SectionCCTP[]; rawParagraphs: Array<{text: string, style: string | null}> } {
  const struct = loadDocxStructure(filePath);
  const roots: SectionCCTP[] = [];
  const flat: SectionCCTP[] = [];
  const stack: Array<{ lvl: number; sec: SectionCCTP }> = [];
  const rawParagraphs: Array<{text: string, style: string | null}> = [];

  for (const el of struct.allElements) {
    if (el.type === 'paragraph') {
      rawParagraphs.push({ text: el.text, style: el.styleName });
      const lvl = headingLevel(el.styleName);
      const text = el.text.trim();

      if (lvl !== null && text) {
        const section: SectionCCTP = {
          niveau: lvl,
          numero: null,
          titre: text,
          texte: '',
          enfants: [],
        };
        flat.push(section);

        // Pop stack until parent level < current level
        while (stack.length > 0 && stack[stack.length - 1].lvl >= lvl) {
          stack.pop();
        }

        if (stack.length > 0) {
          stack[stack.length - 1].sec.enfants.push(section);
        } else {
          roots.push(section);
        }
        stack.push({ lvl, sec: section });
      } else if (text && stack.length > 0) {
        const cur = stack[stack.length - 1].sec;
        cur.texte = cur.texte ? `${cur.texte}\n${text}`.trim() : text;
      }
    }
  }

  return { roots, flat, rawParagraphs };
}

function fullTextOf(section: SectionCCTP): string {
  let parts = [section.texte];
  for (const child of section.enfants) {
    parts.push(fullTextOf(child));
  }
  return parts.join('\n').trim();
}

const NON_PRESTATION_L1 = [
  'obligations du titulaire',
  'dispositions particulieres',
  'dispositions particulières',
  'accueil de stagiaires',
  'contrôle interne',
  'controle interne',
];

function isPrestationBranch(l1Title: string | null): boolean {
  if (!l1Title) return true;
  const low = l1Title.toLowerCase();
  return !NON_PRESTATION_L1.some(k => low.includes(k));
}

function extractPrestations(flat: SectionCCTP[]): Prestation[] {
  const prestations: Prestation[] = [];
  let currentLot: number | null = null;
  let currentCampus: string | null = null;
  let currentL1: string | null = null;

  for (const sec of flat) {
    if (sec.niveau === 1) {
      currentL1 = sec.titre;
      currentLot = detectLot(sec.titre);
      currentCampus = null;
    }
    if (sec.niveau === 3 && sec.titre.toLowerCase().includes('campus')) {
      currentCampus = sec.titre;
    }

    if (!isPrestationBranch(currentL1)) {
      continue;
    }

    const ptype = classifyPrestationType(sec.titre);
    if (ptype !== null) {
      let lot = currentLot;
      if (ptype === TypePrestation.TELESECURITE && lot === null) {
        lot = 3;
      }
      prestations.push({
        type: ptype,
        lot,
        campus: sec.niveau >= 3 ? currentCampus : null,
        description: sec.titre,
        ref_section: sec.titre,
      });
    }
  }
  return prestations;
}

function extractExigencesAgents(flat: SectionCCTP[]): ExigenceAgent[] {
  const exigences: ExigenceAgent[] = [];
  const seen = new Set<string>();

  // (a) sections whose title denotes a requirement
  for (const sec of flat) {
    const low = sec.titre.toLowerCase();
    for (const [token, cat] of EXIGENCE_TITLE_MAP) {
      if (low.includes(token)) {
        const key = `${cat}:${sec.titre}`;
        if (!seen.has(key)) {
          seen.add(key);
          exigences.push({
            categorie: cat,
            libelle: sec.titre,
            valeur: sec.texte ? sec.texte.substring(0, 500) : null,
            ref_section: sec.titre,
          });
        }
        break;
      }
    }
  }

  // (b) regulatory qualifications mentioned in the body
  const fullText = flat.filter(s => s.niveau === 1).map(s => fullTextOf(s)).join('\n');
  const fullPlusTitles = `${fullText}\n${flat.map(s => s.titre).join('\n')}`;

  for (const token of QUALIF_TOKENS) {
    const re = new RegExp(token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    if (re.test(fullPlusTitles)) {
      const norm = token.toUpperCase().replace(/\s+/g, '');
      const key = `${CategorieExigence.QUALIFICATION}:${norm}`;
      if (!seen.has(key)) {
        seen.add(key);
        exigences.push({
          categorie: CategorieExigence.QUALIFICATION,
          libelle: `Qualification requise : ${token}`,
          valeur: token,
          ref_section: null,
        });
      }
    }
  }

  return exigences;
}

function detectReprisePersonnel(flat: SectionCCTP[]): boolean {
  return flat.some(s => s.titre.toLowerCase().includes('reprise du personnel'));
}

function detectContraintesSite(flat: SectionCCTP[]): string[] {
  const contraintes: string[] = [];
  for (const sec of flat) {
    const low = sec.titre.toLowerCase();
    if (low.includes('zrr') || (low.includes('zone') && low.includes('restrict'))) {
      contraintes.push(sec.titre);
    }
    if (low.includes('filtrage')) {
      contraintes.push(sec.titre);
    }
  }
  return contraintes;
}

function detectObjet(rawParagraphs: Array<{text: string, style: string | null}>, flat: SectionCCTP[]): string | null {
  // 1) explicit "Objet" style
  for (const p of rawParagraphs) {
    if (p.style === 'Objet' && p.text.trim()) {
      return p.text.trim();
    }
  }
  // 2) next paragraph after "ayant pour objet"
  const paras = rawParagraphs.map(p => p.text.trim());
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].toLowerCase().includes('ayant pour objet')) {
      const nxt = paras.slice(i + 1).find(x => x);
      if (nxt) return nxt;
    }
  }
  // 3) fallback
  return flat.length > 0 ? flat[0].titre : null;
}

export function parseCctp(filePath: string): CCTPDocument {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  if (ext !== '.docx') {
    throw new Error(`parseCctp attend un .docx (reçu ${ext}). Convertir d'abord.`);
  }

  const warnings: string[] = [];
  const { roots, flat, rawParagraphs } = buildTree(filePath);

  if (flat.length === 0) {
    warnings.push('Aucun titre (Heading/Titre) détecté — structure inattendue.');
  }

  const prestations = extractPrestations(flat);
  const exigences = extractExigencesAgents(flat);

  if (prestations.length === 0) {
    warnings.push('Aucune prestation dérivée des titres.');
  }
  if (exigences.length === 0) {
    warnings.push('Aucune exigence agent détectée.');
  }

  return {
    objet: detectObjet(rawParagraphs, flat),
    arborescence: roots,
    prestations,
    exigences_agents: exigences,
    contraintes_site: detectContraintesSite(flat),
    reprise_personnel: detectReprisePersonnel(flat),
    source: {
      fichier: filePath.substring(filePath.lastIndexOf('/') + 1).substring(filePath.lastIndexOf('\\') + 1),
      methode_extraction: ExtractionMethod.DOCX_NATIVE,
      warnings,
    },
  };
}
