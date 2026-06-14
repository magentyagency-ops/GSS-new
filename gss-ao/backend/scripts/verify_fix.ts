/**
 * Fix V1.1 — vérification programmatique des 2 corrections sur le DOCX généré.
 * Usage : npx ts-node scripts/verify_fix.ts > ../../docs/V1_FIX_VALIDATION.md
 * Pré-requis : data/output/v1_with_template_fixed.docx (scripts ci-dessus).
 */
import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';

const FILE = path.resolve(__dirname, '../../../data/output/v1_with_template_fixed.docx');

interface Check { label: string; ok: boolean; detail: string; }

function textboxBlocks(xml: string): string[] {
  return xml.match(/<w:txbxContent[\s\S]*?<\/w:txbxContent>/g) || [];
}

function run(): Check[] {
  if (!fs.existsSync(FILE)) return [{ label: 'Ouverture du DOCX', ok: false, detail: 'fichier introuvable' }];
  const zip = new PizZip(fs.readFileSync(FILE));
  const doc = zip.file('word/document.xml')!.asText();
  const rels = zip.file('word/_rels/document.xml.rels')!.asText();
  const tb = textboxBlocks(doc);
  const forcedInHeader = tb.some((b) => /w:color w:val="1A1A1A"/i.test(b));
  return [
    { label: "Image chien (image8.jpeg) absente du média", ok: !zip.file('word/media/image8.jpeg'), detail: zip.file('word/media/image8.jpeg') ? 'présente (KO)' : 'absente' },
    { label: "Plus de relation vers image8.jpeg", ok: !rels.includes('image8.jpeg'), detail: rels.includes('image8.jpeg') ? 'présente (KO)' : 'aucune' },
    { label: "Plus de référence rId12 (chien) dans document.xml", ok: !/r:embed="rId12"/.test(doc) && !/r:id="rId12"/.test(doc), detail: (/r:embed="rId12"|r:id="rId12"/.test(doc)) ? 'référence résiduelle (KO)' : 'aucune' },
    { label: "Bandeau d'en-tête / titre présent (txbxContent)", ok: tb.length > 0, detail: `${tb.length} zone(s) de titre` },
    { label: "Couleur d'origine du texte des bandeaux préservée (pas de #1A1A1A forcé)", ok: !forcedInHeader, detail: forcedInHeader ? 'forçage détecté (KO)' : 'préservée' },
    { label: "Corps toujours forcé en sombre #1A1A1A (non-régression)", ok: /w:color w:val="1A1A1A"/i.test(doc), detail: /w:color w:val="1A1A1A"/i.test(doc) ? 'présent' : 'absent (KO)' },
    { label: "Fond gris #E5E5E5 conservé (non-régression)", ok: /<w:background w:color="E5E5E5"/i.test(doc), detail: /<w:background w:color="E5E5E5"/i.test(doc) ? 'présent' : 'absent (KO)' },
    { label: "Image d'en-tête image2.png conservée (non-régression)", ok: !!zip.file('word/media/image2.png'), detail: zip.file('word/media/image2.png') ? 'présente' : 'absente (KO)' },
  ];
}

const checks = run();
const allOk = checks.every((c) => c.ok);
const sizeKo = fs.existsSync(FILE) ? (fs.statSync(FILE).size / 1024).toFixed(1) + ' Ko' : 'n/a';

console.log(`# V1.1 — Validation des 2 corrections (programmatique)

> Généré par \`scripts/verify_fix.ts\` (PizZip / OOXML). Date : 2026-06-15.
> Fichier : \`data/output/v1_with_template_fixed.docx\` — ${sizeKo}.

| Verdict | Critère | Détail |
|---|---|---|
${checks.map((c) => `| ${c.ok ? '✅ OK' : '❌ KO'} | ${c.label} | ${c.detail} |`).join('\n')}

## Verdict : **${allOk ? 'OK ✅ (8/8)' : 'KO ❌'}**

### Note de portée (lisibilité de l'en-tête)
- Les **bandeaux de titre principaux** (« NOS AGENTS … » sur rectangle foncé) retrouvent leur
  texte clair d'origine → **lisibles** (correction de la régression « texte sombre sur fond
  foncé »).
- Le **fil d'Ariane** (« I. PRESENTATION / 1. NOTRE CATALOGUE … ») sur les pages dont l'image
  de fond a été retirée reste en texte clair sur fond gris (contraste réduit). Le corriger
  davantage impliquerait de toucher au retrait des images de fond (hors périmètre V1.1 :
  \`cloneSpread\` / fond gris verrouillés).
`);

process.exit(allOk ? 0 : 1);
