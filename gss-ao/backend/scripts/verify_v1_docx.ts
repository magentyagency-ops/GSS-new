/**
 * Phase 2 — Vérification programmatique des DOCX V1 (structure OOXML).
 * Ouvre les deux DOCX avec PizZip et assertionne la refonte (fond gris, header
 * conservé, images décoratives retirées) vs la génération nue (assertions inverses).
 *
 * Usage : npx ts-node scripts/verify_v1_docx.ts > ../../docs/V1_DOCX_STRUCTURE_CHECK.md
 */
import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';

const OUT_DIR = path.resolve(__dirname, '../../../data/output');
const WITH = path.join(OUT_DIR, 'v1_with_template.docx');
const NUDE = path.join(OUT_DIR, 'v1_no_template.docx');

interface Check { label: string; ok: boolean; detail: string; }

function inspect(file: string): { zip: PizZip | null; doc: string; settings: string; mediaCount: number; error?: string } {
  if (!fs.existsSync(file)) return { zip: null, doc: '', settings: '', mediaCount: 0, error: 'fichier introuvable' };
  try {
    const zip = new PizZip(fs.readFileSync(file));
    const doc = zip.file('word/document.xml')?.asText() || '';
    const settings = zip.file('word/settings.xml')?.asText() || '';
    const mediaCount = Object.keys(zip.files).filter((n) => n.startsWith('word/media/')).length;
    return { zip, doc, settings, mediaCount };
  } catch (e: any) {
    return { zip: null, doc: '', settings: '', mediaCount: 0, error: e.message };
  }
}

function checkWith(): Check[] {
  const { zip, doc, settings, mediaCount, error } = inspect(WITH);
  if (!zip) return [{ label: 'Ouverture du DOCX', ok: false, detail: error || 'KO' }];
  const headerXml = zip.file('word/header1.xml')?.asText() || '';
  const headerRels = zip.file('word/_rels/header1.xml.rels')?.asText() || '';
  const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
  return [
    { label: 'Ouverture du DOCX (zip valide)', ok: true, detail: `${Object.keys(zip.files).length} parts` },
    { label: 'Fond gris `<w:background w:color="E5E5E5"/>`', ok: doc.includes('<w:background w:color="E5E5E5"/>'), detail: doc.includes('<w:background w:color="E5E5E5"/>') ? 'présent' : 'ABSENT' },
    { label: 'Affichage du fond `displayBackgroundShape`', ok: settings.includes('displayBackgroundShape'), detail: settings.includes('displayBackgroundShape') ? 'activé' : 'ABSENT' },
    { label: 'En-tête `word/header1.xml` présent', ok: !!headerXml, detail: headerXml ? 'présent' : 'ABSENT' },
    { label: 'header1.xml référence une image (`r:embed`)', ok: /r:embed="rId\d+"/.test(headerXml), detail: (headerXml.match(/r:embed="rId\d+"/) || ['—'])[0] },
    { label: 'header1.xml.rels → image2.png', ok: headerRels.includes('media/image2.png'), detail: headerRels.includes('media/image2.png') ? 'média/image2.png' : 'ABSENT' },
    { label: 'Référence d\'en-tête sur sectPr `<w:headerReference>`', ok: /<w:headerReference/.test(doc), detail: `${(doc.match(/<w:headerReference/g) || []).length} référence(s)` },
    { label: 'Une seule image réelle dans word/media/', ok: mediaCount === 1, detail: `${mediaCount} image(s) : ${media.map((m) => path.basename(m)).join(', ') || '—'}` },
  ];
}

function checkNude(): Check[] {
  const { zip, doc, settings, mediaCount, error } = inspect(NUDE);
  if (!zip) return [{ label: 'Ouverture du DOCX', ok: false, detail: error || 'KO' }];
  return [
    { label: 'Ouverture du DOCX (zip valide)', ok: true, detail: `${Object.keys(zip.files).length} parts` },
    { label: 'PAS de fond gris', ok: !doc.includes('<w:background'), detail: doc.includes('<w:background') ? 'fond présent (inattendu)' : 'aucun <w:background>' },
    { label: 'PAS de displayBackgroundShape', ok: !settings.includes('displayBackgroundShape'), detail: settings.includes('displayBackgroundShape') ? 'présent (inattendu)' : 'absent' },
    { label: 'PAS d\'en-tête header1.xml', ok: !zip.file('word/header1.xml'), detail: zip.file('word/header1.xml') ? 'présent (inattendu)' : 'absent' },
    { label: 'PAS de headerReference', ok: !/<w:headerReference/.test(doc), detail: /<w:headerReference/.test(doc) ? 'présent (inattendu)' : 'absent' },
    { label: 'Aucune image dans word/media/', ok: mediaCount === 0, detail: `${mediaCount} image(s)` },
  ];
}

function fmt(checks: Check[]): string {
  const rows = checks.map((c) => `| ${c.ok ? '✅ OK' : '❌ KO'} | ${c.label} | ${c.detail} |`).join('\n');
  return `| Verdict | Assertion | Détail |\n|---|---|---|\n${rows}`;
}

const w = checkWith();
const n = checkNude();
const allOk = [...w, ...n].every((c) => c.ok);
const sizeOf = (f: string) => (fs.existsSync(f) ? (fs.statSync(f).size / 1024).toFixed(1) + ' Ko' : 'absent');

console.log(`# V1 — Vérification programmatique de la structure des DOCX

> Phase 2 — généré par \`scripts/verify_v1_docx.ts\` (PizZip / OOXML). Date : 2026-06-14.

## Fichiers vérifiés
- \`data/output/v1_with_template.docx\` — ${sizeOf(WITH)} (Mode A, template refondu)
- \`data/output/v1_no_template.docx\` — ${sizeOf(NUDE)} (Mode B, nu)

## Mode A — template refondu (assertions de conformité)

${fmt(w)}

## Mode B — sans template (assertions inverses)

${fmt(n)}

## Verdict global

**Conformité à la commande tuteur : ${allOk ? 'OUI' : 'NON'}** — fond gris uniforme #E5E5E5 ${w[1]?.ok ? '✅' : '❌'}, bandeau d'en-tête conservé sur chaque page ${w[3]?.ok && w[6]?.ok ? '✅' : '❌'}, images décoratives retirées (1 seule image conservée) ${w[7]?.ok ? '✅' : '❌'}. Génération nue dépourvue de fond/header/images comme attendu ${n.slice(1).every((c) => c.ok) ? '✅' : '❌'}.
`);

process.exit(allOk ? 0 : 1);
