import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import PizZip from 'pizzip';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

const SAMPLE: AssembleChapter[] = [
  { key: 'I', title: 'Présentation', sections: [{ title: 'Notre catalogue de prestations', text: 'GSS agréée CNAPS.' }] },
  { key: 'II', title: 'Moyens humains', sections: [{ title: 'Qualifications des agents', text: 'CQP APS.' }] },
];

describe('V1.4 — bandeau inline (zone B) : bande sombre sur les zones de titre', () => {
  let zip: PizZip;
  let documentXml: string;

  beforeAll(async () => {
    const gen = new MemoireGenerator();
    const res = await gen.assembleFromSections('export', SAMPLE, { refonte: true });
    zip = new PizZip(fs.readFileSync(res.filePath));
    documentXml = zip.file('word/document.xml')!.asText();
  });

  it('les zones de titre (txbxContent) reçoivent une trame de paragraphe sombre #494545', () => {
    // les bandeaux inline portent désormais leur propre fond foncé (w:shd) au niveau paragraphe
    const shdDark = (documentXml.match(/<w:shd[^>]*w:fill="494545"/g) || []).length;
    expect(shdDark).toBeGreaterThan(0);
  });

  it('le logo du bandeau (image5.png) n\'est PLUS retiré par stripStandaloneBgImages', () => {
    // image5 conservée dans le paquet (bande/logo préservés)
    expect(zip.file('word/media/image5.png')).toBeTruthy();
    // nombre de logos >= celui du template (95) — plus aucun retrait du logo
    const logos = (documentXml.match(/r:embed="rId9"/g) || []).length;
    expect(logos).toBeGreaterThanOrEqual(95);
  });

  it('le texte des bandeaux inline est clair (#F5F5DB) — lisible sur fond foncé', () => {
    expect(documentXml).toContain('F5F5DB');
  });

  it('périmètre : V1.2 (décoratifs absents) et V1.3 (headerReference) intacts + fond gris', () => {
    expect(zip.file('word/media/image8.jpeg')).toBeFalsy();   // décoratif V1.2 toujours retiré
    expect((documentXml.match(/headerReference/g) || []).length).toBeGreaterThan(0); // V1.3 intact
    expect(documentXml).toContain('<w:background w:color="E5E5E5"'); // fond gris intact
  });
});
