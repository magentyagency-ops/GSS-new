import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import PizZip from 'pizzip';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

const SAMPLE: AssembleChapter[] = [
  {
    key: 'I',
    title: 'Présentation de notre structure',
    sections: [
      { title: 'Notre catalogue de prestations', text: 'GSS propose une offre complète de sécurité privée.\nNos agents sont agréés CNAPS.' },
      { title: 'Nos valeurs', text: 'Engagement, proximité et qualité de service.' },
    ],
  },
];

const DOG_MEDIA = 'word/media/image8.jpeg';
const BACKGROUND_HEX = 'E5E5E5';
const HEADER_IMAGE = 'word/media/image2.png';

/** Extrait tous les blocs <w:txbxContent>…</w:txbxContent> du XML. */
function textboxBlocks(xml: string): string[] {
  return xml.match(/<w:txbxContent[\s\S]*?<\/w:txbxContent>/g) || [];
}

describe('Fix V1.1 — image chien retirée + header lisible', () => {
  let zip: PizZip;
  let documentXml: string;
  let rels: string;
  let generatedData: Record<string, string>;

  beforeAll(async () => {
    const gen = new MemoireGenerator();
    const res = await gen.assembleFromSections('export', SAMPLE, { refonte: true });
    zip = new PizZip(fs.readFileSync(res.filePath));
    documentXml = zip.file('word/document.xml')!.asText();
    rels = zip.file('word/_rels/document.xml.rels')!.asText();
    generatedData = res.generatedData;
  });

  it("ne référence plus l'image chien (image8.jpeg)", () => {
    expect(rels).not.toContain('media/image8.jpeg');
    // plus aucune référence exacte au rId du chien (rId12) — ni DrawingML ni VML.
    // (match exact avec guillemet fermant : 'rId12' est aussi un préfixe de rId120-rId129)
    expect(documentXml).not.toMatch(/r:embed="rId12"/);
    expect(documentXml).not.toMatch(/r:id="rId12"/);
  });

  it("retire le fichier média de l'image chien", () => {
    expect(zip.file(DOG_MEDIA)).toBeFalsy();
  });

  it('ne force PAS la couleur sombre (#1A1A1A) dans les bandeaux de titre (txbxContent)', () => {
    const blocks = textboxBlocks(documentXml);
    expect(blocks.length).toBeGreaterThan(0);
    const forcedInHeader = blocks.some((b) => /w:color w:val="1A1A1A"/i.test(b));
    expect(forcedInHeader).toBe(false);
  });

  it('force TOUJOURS la couleur sombre (#1A1A1A) sur le corps (non-régression)', () => {
    expect(/w:color w:val="1A1A1A"/i.test(documentXml)).toBe(true);
  });

  it('conserve le fond gris #E5E5E5 (non-régression)', () => {
    expect(documentXml).toContain(`<w:background w:color="${BACKGROUND_HEX}"`);
  });

  it("conserve l'image d'en-tête image2.png (non-régression)", () => {
    expect(zip.file(HEADER_IMAGE)).toBeTruthy();
  });
});
