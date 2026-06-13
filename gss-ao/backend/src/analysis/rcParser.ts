import { DateEcheance, Lot, SourceMeta, ExtractionMethod } from '../schemas/common';
import { RCDocument, PieceAFournir, CriteresNotation, Visite, ModalitesRemise, TypePiece, SousCritere } from '../schemas/rc';
import { extractDocText, loadDocxText } from '../ingestion/docConverter';

const MONTHS_FR: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  decembre: 12,
};

const DATE_RE = /(\d{1,2})\s+([A-Za-zéûôîèà]+)\s+(\d{4})/i;
const CPV_RE = /\b(\d{8}-\d)\b/g;

// Sous-critère regex
const SOUSCRIT_RE = /^(.+?)\s*:\s*(\d+)\s*points?\s*(?:\(([^)]*)\))?[\s,.;]*$/i;

// Section regex
const SECTION_RE = /^\s*(\d{1,2}(?:\.\d{1,2})?)\s+[–—\-]\s+(.+?)\s*$/;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parseFrDate(text: string): string | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthStr = stripAccents(m[2]).toLowerCase();
  const year = parseInt(m[3], 10);
  const month = MONTHS_FR[monthStr];
  if (!month) return null;

  try {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch (e) {
    return null;
  }
}

class Section {
  num: string;
  title: string;
  start: number;
  end: number = -1;
  lines: string[] = [];

  constructor(num: string, title: string, start: number) {
    this.num = num;
    this.title = title;
    this.start = start;
  }

  get text(): string {
    return this.lines.join('\n').trim();
  }
}

function splitSections(lines: string[]): Section[] {
  const raw: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SECTION_RE.exec(line);
    if (m) {
      raw.push(new Section(m[1], m[2].trim(), i));
    }
  }

  // Set boundary ends
  for (let idx = 0; idx < raw.length; idx++) {
    const nxt = idx + 1 < raw.length ? raw[idx + 1].start : lines.length;
    raw[idx].end = nxt;
    raw[idx].lines = lines.slice(raw[idx].start + 1, nxt);
  }

  // Deduplicate table of contents: keep the longest section by num
  const byNum: Record<string, Section> = {};
  for (const sec of raw) {
    const prev = byNum[sec.num];
    if (!prev || sec.text.length > prev.text.length) {
      byNum[sec.num] = sec;
    }
  }

  return Object.values(byNum);
}

function findSection(sections: Section[], num: string): Section | null {
  return sections.find(s => s.num === num) || null;
}

const PIECES_CANDIDATURE: [string, string][] = [
  ['declaration sur l.honneur', "Déclaration sur l'honneur"],
  ['\\bDC1\\b', "DC1 — Lettre de candidature"],
  ['\\bDC2\\b', "DC2 — Déclaration du candidat"],
  ['note de pr[ée]sentation', "Note de présentation de l'entreprise"],
  ['r[ée]f[ée]rences.*?(moins de\\s*)?3\\s*ans|liste.*?r[ée]f[ée]rences', "Liste de références (< 3 ans)"],
  ['r[ée]gularit[ée].*fiscale|attestation.*fiscale', "Attestation de régularité fiscale"],
  ['attestations?\\s*d.assurance', "Attestations d'assurance"],
];
const PIECE_DUME: [string, string] = ['\\bDUME\\b', "DUME (alternative à DC1/DC2)"];

const PIECES_OFFRE: [string, string][] = [
  ['acte d.engagement', "Acte d'Engagement complété, daté et signé"],
  ['\\bBPU\\b|bordereau de prix', "BPU — Bordereau de Prix Unitaire"],
  ['\\bDPGF\\b|d[ée]composition du prix', "DPGF — Décomposition du Prix Global et Forfaitaire"],
  ['m[ée]moire technique', "Mémoire technique valant cadre de réponse"],
  ['\\bRIB\\b', "RIB de l'entreprise"],
];

function extractPieces(section: Section | null, specs: [string, string][], type: TypePiece): PieceAFournir[] {
  const pieces: PieceAFournir[] = [];
  if (!section) return pieces;
  const text = section.text;

  for (const [pattern, label] of specs) {
    const re = new RegExp(pattern, 'i');
    if (re.test(text)) {
      const ref = section.lines.find(ln => re.test(ln)) || null;
      pieces.push({
        nom: label,
        type,
        obligatoire: true,
        alternative: null,
        ref_texte: ref ? ref.trim() : null,
      });
    }
  }
  return pieces;
}

function extractObjet(lines: string[], sections: Section[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.toLowerCase().includes('ayant pour objet')) {
      const after = ln.includes(':') ? ln.split(':', 2)[1].trim() : '';
      const parts = after ? [after] : [];
      for (const nxt of lines.slice(i + 1, i + 4)) {
        const s = nxt.trim();
        if (!s || s.toLowerCase().includes('mode de passation')) {
          break;
        }
        parts.push(s);
      }
      let objet = parts.join(' ').trim();
      objet = objet.replace(/(\w)-\s+(\w)/g, '$1-$2');
      if (objet) return objet;
    }
  }
  const sec = findSection(sections, '1.1') || findSection(sections, '1');
  if (sec && sec.text) {
    return sec.text.split('\n')[0].trim();
  }
  return null;
}

function extractAcheteur(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.toLowerCase().includes('pouvoir adjudicateur')) {
      for (const nxt of lines.slice(i + 1, i + 6)) {
        const s = nxt.trim();
        if (s && s[0] === s[0].toUpperCase() && stripAccents(s).toLowerCase().includes('universit')) {
          return s;
        }
      }
    }
  }
  const fullText = lines.join('\n');
  const m = /\b(UNIVERSIT[EÉ]\s+DE\s+[A-ZÉÈÀ ]{3,})/i.exec(fullText);
  return m ? m[1].trim() : null;
}

function extractCcag(lines: string[]): string | null {
  const m = /CCAG\s*[–\-]?\s*([A-Z]{2,4})/i.exec(lines.join('\n'));
  return m ? `CCAG-${m[1].toUpperCase()}` : null;
}

function extractCpv(lines: string[]): string[] {
  const fullText = lines.join('\n');
  const found: string[] = [];
  let m;
  const regex = new RegExp(CPV_RE);
  while ((m = regex.exec(fullText)) !== null) {
    found.push(m[1]);
  }
  return Array.from(new Set(found)).sort();
}

function extractAllotissement(sections: Section[]): Lot[] {
  const sec = findSection(sections, '1.4');
  if (!sec) return [];
  const lots: Lot[] = [];
  const lines = sec.lines.map(ln => ln.trim());

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^[1-9]$/.test(ln)) {
      const intitule = lines.slice(i + 1, i + 4).find(x => x && !/^[\d\s,.\-]+$/.test(x)) || null;
      if (intitule && !lots.some(lot => lot.numero === parseInt(ln, 10))) {
        let perimetre: string | null = null;
        const mdept = /département\s*(\d{2})/i.exec(intitule);
        if (mdept) {
          perimetre = `Département ${mdept[1]}`;
        } else if (intitule.toLowerCase().includes('télé') || stripAccents(intitule).toLowerCase().includes('tele')) {
          perimetre = 'Télésécurité';
        }
        lots.push({ numero: parseInt(ln, 10), intitule, perimetre });
      }
    }
  }
  return lots;
}

function extractDuree(sections: Section[]): string | null {
  const sec = findSection(sections, '1.9');
  return sec && sec.text ? sec.text.split(/\s+/).join(' ').trim() : null;
}

function extractVisite(sections: Section[]): Visite {
  const sec = findSection(sections, '2.6');
  if (!sec) return { prevue: false, obligatoire: null, dates: [], lieu: null, ref_texte: null };
  const text = sec.text;
  const low = text.toLowerCase();
  if (!text || low.includes('sans objet')) {
    return { prevue: false, obligatoire: null, dates: [], lieu: null, ref_texte: text || null };
  }
  const obligatoire = low.includes('obligatoire');
  const dates: DateEcheance[] = [];

  for (const ln of sec.lines) {
    const lnLow = ln.toLowerCase();
    if (/pr[ée]vue|aura lieu|organis/i.test(ln) || DATE_RE.test(ln)) {
      const d = parseFrDate(ln);
      if (d || lnLow.includes('visite')) {
        dates.push({
          libelle: 'Visite des locaux',
          valeur: d,
          texte_brut: d === null ? ln.trim() : null,
        });
      }
    }
  }

  let lieu: string | null = null;
  for (let i = 0; i < sec.lines.length; i++) {
    if (sec.lines[i].toLowerCase().includes('lieu de rendez-vous')) {
      lieu = sec.lines.slice(i + 1, i + 4).map(x => x.trim()).filter(Boolean).join(' ') || null;
      break;
    }
  }

  return {
    prevue: true,
    obligatoire,
    dates: dates.some(d => d.valeur !== null) ? dates.filter(d => d.valeur !== null) : dates,
    lieu,
    ref_texte: text.substring(0, 500),
  };
}

function scopeToLots(scope: string | null): number[] {
  if (!scope) return [];
  const low = scope.toLowerCase();
  if (low.includes('tous')) return [];
  const lots: number[] = [];
  const m = low.match(/\d+/g);
  if (m) {
    for (const n of m) {
      lots.push(parseInt(n, 10));
    }
  }
  return lots;
}

function extractCriteres(sections: Section[]): CriteresNotation | null {
  const sec = findSection(sections, '6');
  if (!sec) return null;
  let vt: number | null = null;
  let prix: number | null = null;
  const sous: SousCritere[] = [];

  for (const ln of sec.lines) {
    const s = ln.trim();
    if (!s) continue;
    const m = SOUSCRIT_RE.exec(s);
    if (!m) continue;
    const lib = m[1].trim().replace(/^«|»$/g, '').trim();
    const pts = parseFloat(m[2]);
    const low = stripAccents(lib).toLowerCase();
    if (low.startsWith('valeur technique')) {
      vt = pts;
    } else if (low.startsWith('prix')) {
      prix = pts;
    } else {
      sous.push({
        libelle: lib,
        points: pts,
        lots: scopeToLots(m[3] || null),
      });
    }
  }
  if (vt === null && prix === null && sous.length === 0) return null;
  return {
    valeur_technique_pts: vt || 0,
    prix_pts: prix || 0,
    sous_criteres: sous,
  };
}

function extractModalites(lines: string[]): ModalitesRemise {
  const joined = lines.join('\n');
  let plateforme: string | null = null;
  const mplat = /(achatpublic\.com|[\w.-]+\.nukema\.com|[\w.-]+marches[\w.-]*)/i.exec(joined);
  if (mplat) {
    plateforme = mplat[1];
  }

  const signature_formats: string[] = [];
  for (const fmt of ['XAdES', 'CAdES', 'PAdES']) {
    const re = new RegExp(fmt, 'i');
    if (re.test(joined)) {
      signature_formats.push(fmt);
    }
  }
  if (signature_formats.length === 0 && /signature\s+électronique|\bRGS\b/i.test(joined)) {
    signature_formats.push('Signature électronique (RGS)');
  }

  let date_limite: DateEcheance | null = null;
  for (const ln of lines) {
    if (ln.toLowerCase().includes('date limite') && ln.toLowerCase().includes('offre')) {
      date_limite = {
        libelle: 'Date limite de dépôt des offres',
        valeur: parseFrDate(ln),
        texte_brut: ln.trim(),
      };
      break;
    }
  }

  return {
    plateforme,
    signature_formats,
    date_limite,
  };
}

export function parseRc(filePath: string): RCDocument {
  const warnings: string[] = [];
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  let text = '';
  let method: ExtractionMethod;

  if (ext === '.doc') {
    const res = extractDocText(filePath);
    text = res.text;
    method = res.method;
  } else if (ext === '.docx') {
    text = loadDocxText(filePath);
    method = ExtractionMethod.DOCX_NATIVE;
  } else {
    throw new Error(`parseRc attend un .doc ou .docx (reçu ${ext}).`);
  }

  const lines = text.split(/\r?\n/).map(ln => ln.trimEnd());
  const sections = splitSections(lines);
  if (sections.length === 0) {
    warnings.push('Aucune section numérotée détectée — structure inattendue.');
  }

  const secCand = findSection(sections, '4.1');
  const piecesCand = extractPieces(secCand, PIECES_CANDIDATURE, TypePiece.CANDIDATURE);
  const dume = extractPieces(secCand, [PIECE_DUME], TypePiece.CANDIDATURE);
  for (const p of dume) {
    p.obligatoire = false;
    p.alternative = 'Remplace DC1+DC2';
  }
  piecesCand.push(...dume);

  const secOffre = findSection(sections, '4.2');
  const piecesOffre = extractPieces(secOffre, PIECES_OFFRE, TypePiece.OFFRE);

  const criteres = extractCriteres(sections);
  if (!criteres) {
    warnings.push('Barème de notation non détecté (section 6).');
  }
  if (piecesCand.length === 0) {
    warnings.push('Aucune pièce de candidature détectée (section 4.1).');
  }
  if (piecesOffre.length === 0) {
    warnings.push("Aucune pièce d'offre détectée (section 4.2).");
  }

  return {
    objet: extractObjet(lines, sections),
    acheteur: extractAcheteur(lines),
    ccag: extractCcag(lines),
    cpv: extractCpv(lines),
    duree: extractDuree(sections),
    allotissement: extractAllotissement(sections),
    visite: extractVisite(sections),
    pieces_candidature: piecesCand,
    pieces_offre: piecesOffre,
    criteres,
    modalites_remise: extractModalites(lines),
    source: {
      fichier: filePath.substring(filePath.lastIndexOf('/') + 1).substring(filePath.lastIndexOf('\\') + 1),
      methode_extraction: method,
      warnings,
    },
  };
}
