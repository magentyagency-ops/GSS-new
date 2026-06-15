import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import PizZip from 'pizzip';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-used';

import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

const SAMPLE: AssembleChapter[] = [
  {
    key: 'I',
    title: 'Présentation',
    sections: [
      { title: 'Notre catalogue de prestations', text: 'GSS agréée CNAPS.\n- Surveillance\n- Cynophile' },
      { title: 'Nos valeurs', text: 'Engagement et qualité.' },
    ],
  },
  {
    key: 'II',
    title: 'Moyens humains',
    sections: [
      { title: 'Reprise du personnel en place', text: 'GSS organise la reprise selon L1224-1.' },
    ],
  },
];

// Photos décoratives "agent + légende" du maître (à supprimer catégoriquement).
const DECORATIVE = ['image8.jpeg', 'image9.jpeg', 'image10.jpeg', 'image11.jpeg', 'image12.jpeg', 'image13.jpeg', 'image14.jpeg'];
// Logo bandeau (à conserver).
const HEADER_LOGO = 'word/media/image5.png';

describe('V1.2 — suppression catégorique des blocs décoratifs + bandeau', () => {
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

  it("retire les 7 fichiers média décoratifs (agents/chien/experts…)", () => {
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/')).map((n) => n.split('/').pop());
    for (const d of DECORATIVE) expect(media).not.toContain(d);
  });

  it("ne référence plus les images décoratives ni leurs relations", () => {
    for (const d of DECORATIVE) expect(rels).not.toContain(`media/${d}`);
    // plus aucune photo décorative embarquée (r:embed) — on ignore les noms de signets résiduels
    const embeds = documentXml.match(/r:embed="(rId\d+)"/g) || [];
    const embeddedMedia = embeds
      .map((e) => e.replace(/.*"(rId\d+)".*/, '$1'))
      .map((rid) => {
        const m = rels.match(new RegExp(`Id="${rid}"[^>]*Target="media/([^"]+)"`));
        return m ? m[1] : '';
      });
    for (const d of DECORATIVE) expect(embeddedMedia).not.toContain(d);
    // la légende visible (zone de titre) du bloc chien a disparu
    const visibleTitles = (documentXml.match(/<w:txbxContent[\s\S]*?<\/w:txbxContent>/g) || []).join(' ');
    expect(visibleTitles).not.toContain('NOS AGENTS CYNOPHILES');
  });

  it('rapporte la suppression (>= 7 blocs décoratifs)', () => {
    expect(Number(generatedData.blocs_decoratifs_retires)).toBeGreaterThanOrEqual(7);
  });

  it("conserve le logo du bandeau (image5.png) et des zones de titre (txbxContent)", () => {
    expect(zip.file(HEADER_LOGO)).toBeTruthy();
    expect(documentXml).toContain('txbxContent');
  });

  it('conserve le titre de section injecté (non-régression contenu)', () => {
    expect(documentXml).toContain('Reprise du personnel en place');
  });

  it('conserve le fond gris #E5E5E5 (non-régression)', () => {
    expect(documentXml).toContain('<w:background w:color="E5E5E5"');
  });

  it("conserve les diagrammes fonctionnels (image109/132/180, multi-légendes)", () => {
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/')).map((n) => n.split('/').pop());
    // au moins un diagramme fonctionnel conservé (non assimilé à un décoratif)
    expect(media).toContain('image109.png');
  });

  it('produit un DOCX valide (médias présents, taille raisonnable)', () => {
    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'));
    expect(media.length).toBeGreaterThan(0);
  });
});
