import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import PizZip from 'pizzip';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

const SAMPLE: AssembleChapter[] = [
  { key: 'I', title: 'Présentation de notre structure', sections: [
    { title: 'Notre catalogue de prestations', text: 'GSS agréée CNAPS.' },
    { title: 'Nos valeurs', text: 'Qualité.' },
  ] },
  { key: 'II', title: 'Les moyens humains', sections: [
    { title: 'Qualifications des agents', text: 'CQP APS.' },
  ] },
];

describe('V1.5 — bandeau GSS par PNG injecté + texte de section', () => {
  let zip: PizZip;
  let documentXml: string;
  let rels: string;

  beforeAll(async () => {
    const gen = new MemoireGenerator();
    const res = await gen.assembleFromSections('export', SAMPLE, { refonte: true });
    zip = new PizZip(fs.readFileSync(res.filePath));
    documentXml = zip.file('word/document.xml')!.asText();
    rels = zip.file('word/_rels/document.xml.rels')!.asText();
  });

  it('embarque le PNG du bandeau (~58 Ko) dans word/media/', () => {
    const png = zip.file('word/media/bandeau_gss_header.png');
    expect(png).toBeTruthy();
    expect(png!.asUint8Array().length).toBeGreaterThan(40000); // ~58 Ko
  });

  it('déclare la relation rIdBandeauGSS vers le PNG', () => {
    expect(rels).toContain('rIdBandeauGSS');
    expect(rels).toContain('media/bandeau_gss_header.png');
  });

  it('insère 1 ancre bandeau (rIdBandeauGSS) par section générée', () => {
    const anchors = (documentXml.match(/r:embed="rIdBandeauGSS"/g) || []).length;
    // SAMPLE = 3 sections avec texte
    expect(anchors).toBe(3);
  });

  it('superpose le texte numéro/titre de section (couleur doré-olive #7F7124)', () => {
    expect(documentXml).toContain('7F7124');
    expect(documentXml).toContain('I. PRÉSENTATION DE NOTRE STRUCTURE');
    expect(documentXml).toContain('1. NOTRE CATALOGUE DE PRESTATIONS');
  });

  it('périmètre : V1.2 (décoratifs absents) + fond gris #E5E5E5 intacts', () => {
    expect(zip.file('word/media/image8.jpeg')).toBeFalsy(); // décoratif V1.2 toujours retiré
    expect(documentXml).toContain('<w:background w:color="E5E5E5"'); // fond gris intact
  });
});
