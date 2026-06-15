import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import PizZip from 'pizzip';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

const SAMPLE: AssembleChapter[] = [
  { key: 'I', title: 'Présentation', sections: [{ title: 'Notre catalogue de prestations', text: 'GSS agréée CNAPS.' }] },
  { key: 'II', title: 'Moyens humains', sections: [{ title: 'Qualifications des agents', text: 'CQP APS et SSIAP.' }] },
];

describe('V1.3 — bandeau GSS (en-tête Word) sur chaque section', () => {
  let zip: PizZip;
  let documentXml: string;
  let headerXml: string;

  beforeAll(async () => {
    const gen = new MemoireGenerator();
    const res = await gen.assembleFromSections('export', SAMPLE, { refonte: true });
    zip = new PizZip(fs.readFileSync(res.filePath));
    documentXml = zip.file('word/document.xml')!.asText();
    headerXml = zip.file('word/header1.xml')?.asText() || '';
  });

  it('a 1 <w:headerReference> par <w:sectPr>', () => {
    const sectPr = (documentXml.match(/<w:sectPr\b/g) || []).length;
    const hdrRef = (documentXml.match(/<w:headerReference\b/g) || []).length;
    expect(sectPr).toBeGreaterThan(0);
    expect(hdrRef).toBe(sectPr);
  });

  it('header1.xml contient le bandeau (fond foncé + logo + texte)', () => {
    expect(headerXml).toContain('<w:shd');
    expect(headerXml).toContain('494545');           // bande sombre
    expect(headerXml).toMatch(/r:embed="rId\d+"/);   // logo GSS (image5)
    expect(headerXml).toContain('MÉMOIRE TECHNIQUE'); // texte du bandeau
    // relation header -> logo
    expect(zip.file('word/_rels/header1.xml.rels')!.asText()).toContain('media/image5.png');
    // override Content_Types
    expect(zip.file('[Content_Types].xml')!.asText()).toContain('word/header1.xml');
  });

  it("le texte du bandeau header n'est PAS forcé en #1A1A1A (texte clair)", () => {
    expect(headerXml).not.toContain('1A1A1A');
    expect(headerXml).toContain('F5F5DB'); // texte clair lisible sur fond foncé
  });

  it('périmètre strict : photos décoratives et fond gris inchangés', () => {
    // fond gris conservé
    expect(documentXml).toContain('<w:background w:color="E5E5E5"');
    // médias toujours présents (design conservé), logo bandeau présent
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
    expect(media.length).toBeGreaterThan(100);
    expect(zip.file('word/media/image5.png')).toBeTruthy();
  });
});
