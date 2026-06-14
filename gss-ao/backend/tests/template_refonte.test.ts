import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import PizZip from 'pizzip';

// Clé factice : aucun appel LLM n'est fait avec dossierId='export' (cover en repli),
// mais le constructeur OpenAI exige une clé présente.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

const SAMPLE: AssembleChapter[] = [
  {
    key: 'I',
    title: 'Présentation de notre structure',
    sections: [
      { title: 'Présentation de la société GSS', text: 'GSS est une société de sécurité privée.\n- Agréée CNAPS\n- Implantée en région' },
    ],
  },
  {
    key: 'II',
    title: 'Les moyens humains',
    sections: [
      { title: 'Qualifications des agents', text: 'Nos agents sont **CQP APS** et SSIAP.' },
    ],
  },
];

const BACKGROUND_HEX = 'E5E5E5';
const HEADER_IMAGE = 'word/media/image2.png';

function openDocx(filePath: string): PizZip {
  expect(fs.existsSync(filePath)).toBe(true);
  return new PizZip(fs.readFileSync(filePath));
}

describe('Refonte template DOCX (Mode B / document propre)', () => {
  let zip: PizZip;
  let documentXml: string;

  beforeAll(async () => {
    const gen = new MemoireGenerator();
    const res = await gen.assembleFromSections('export', SAMPLE);
    zip = openDocx(res.filePath);
    documentXml = zip.file('word/document.xml')!.asText();
  });

  it('applique un fond gris uniforme E5E5E5 + active son affichage', () => {
    expect(documentXml).toContain(`<w:background w:color="${BACKGROUND_HEX}"/>`);
    const settings = zip.file('word/settings.xml')!.asText();
    expect(settings).toContain('displayBackgroundShape');
  });

  it("conserve l'image d'en-tête (bandeau GSS) et la référence sur chaque page", () => {
    // l'image bandeau est conservée dans le paquet
    expect(zip.file(HEADER_IMAGE)).toBeTruthy();
    // un en-tête réel existe et pointe vers cette image
    const headerXml = zip.file('word/header1.xml');
    expect(headerXml).toBeTruthy();
    expect(headerXml!.asText()).toContain('r:embed="rId1"');
    expect(zip.file('word/_rels/header1.xml.rels')!.asText()).toContain('media/image2.png');
    // le sectPr référence l'en-tête → répétition sur chaque page
    expect(documentXml).toContain('<w:headerReference');
  });

  it('retire les images décoratives dupliquées (seul le bandeau subsiste)', () => {
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
    expect(media).toEqual([HEADER_IMAGE]);
    // plus aucune relation média vers une image décorative dans le document
    const docRels = zip.file('word/_rels/document.xml.rels')!.asText();
    expect(docRels).not.toMatch(/Target="media\/image(?!2\.png)/);
  });

  it('produit un DOCX relisible (zip + parts essentielles présentes)', () => {
    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    expect(zip.file('word/document.xml')).toBeTruthy();
    expect(documentXml).toContain('Présentation de la société GSS');
    // l'override de type de contenu de l'en-tête est déclaré
    expect(zip.file('[Content_Types].xml')!.asText()).toContain('word/header1.xml');
  });
});

describe('Génération NUE (sans template)', () => {
  it('produit un DOCX valide sans fond, sans en-tête, sans image', async () => {
    const gen = new MemoireGenerator();
    const res = await gen.assembleFromSections('export', SAMPLE, { noTemplate: true });
    const zip = openDocx(res.filePath);
    const documentXml = zip.file('word/document.xml')!.asText();
    expect(documentXml).not.toContain('<w:background');
    expect(zip.file('word/header1.xml')).toBeFalsy();
    expect(Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))).toHaveLength(0);
    // contenu bien présent malgré l'absence de mise en forme
    expect(documentXml).toContain('Qualifications des agents');
  });
});
