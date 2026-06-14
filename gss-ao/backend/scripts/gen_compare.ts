/**
 * Phase 3 — Génération comparative Mode A (template refondu) vs Mode B (sans template).
 *
 * Le MÊME contenu de sections est rendu par les deux chaînes afin d'isoler ce que le
 * template apporte (structure / mise en forme) vs une génération nue. Aucun appel LLM
 * (dossierId='export' → page de garde en repli) : coût additionnel ≈ 0 €.
 *
 * Usage : OPENAI_API_KEY=dummy npx ts-node scripts/gen_compare.ts
 */
import fs from 'fs';
import path from 'path';
import { MemoireGenerator, AssembleChapter } from '../src/generation/memoire_generator';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-not-used';

// Contenu représentatif (cas Université de Rouen Normandie MP2026-08, profil GSS).
const CHAPTERS: AssembleChapter[] = [
  {
    key: 'I',
    title: 'Présentation de notre structure',
    sections: [
      {
        title: 'Présentation de la société GSS',
        text:
          'GSS (Global Security Service) est une entreprise de sécurité privée agréée CNAPS, spécialisée dans la surveillance humaine de sites sensibles et tertiaires.\n' +
          'Forte de plus de quinze ans d\'expérience, GSS intervient sur des marchés publics exigeants et place la **continuité de service** au cœur de son organisation.\n' +
          '- Autorisation de fonctionnement CNAPS à jour\n' +
          '- Dirigeants titulaires d\'un agrément CNAPS\n' +
          '- Démarche qualité et RSE structurée',
      },
      {
        title: 'Implantation régionale et agences de proximité',
        text:
          'Notre agence normande assure une proximité opérationnelle avec les campus de l\'Université de Rouen Normandie (Mont-Saint-Aignan, Martainville, Pasteur, Madrillet, Évreux).\n' +
          'Cette proximité garantit des temps de réaction courts et un encadrement présent sur le terrain.',
      },
    ],
  },
  {
    key: 'II',
    title: 'Les moyens humains',
    sections: [
      {
        title: 'Qualifications et profils des agents (CQP APS, SSIAP)',
        text:
          'Les agents affectés au marché sont titulaires du **CQP APS** et, selon les postes, des qualifications **SSIAP 1 et 2**.\n' +
          'Chaque agent dispose d\'une carte professionnelle CNAPS valide, vérifiée avant toute prise de poste.',
      },
      {
        title: 'Reprise du personnel en place (article L1224-1)',
        text:
          'GSS organise la reprise du personnel en place conformément à l\'article L1224-1 du Code du travail et à la convention collective.\n' +
          'Un entretien individuel est conduit avec chaque agent repris afin de sécuriser la transition et de maintenir la connaissance des sites.',
      },
    ],
  },
  {
    key: 'III',
    title: 'Les moyens opérationnels',
    sections: [
      {
        title: 'Rondes, pointeaux et main courante électronique',
        text:
          'Les rondes sont tracées par pointeaux NFC et consignées dans une main courante électronique horodatée.\n' +
          'Les rapports sont accessibles au donneur d\'ordre via un extranet dédié.',
      },
      {
        title: 'Gestion des alarmes et procédures d\'intervention',
        text:
          'Toute alarme déclenche une procédure de levée de doute formalisée, avec consignes par site et reporting systématique.\n' +
          '- Qualification de l\'événement\n' +
          '- Intervention selon consigne\n' +
          '- Compte rendu horodaté',
      },
    ],
  },
  {
    key: 'IV',
    title: 'Les moyens organisationnels',
    sections: [
      {
        title: 'Organisation et démarrage de la prestation',
        text:
          'Un plan de démarrage détaillé (J-30 à J+15) sécurise la prise de marché : reprise du personnel, formation aux sites, mise en place des moyens.\n' +
          'Un référent unique est désigné comme interlocuteur du donneur d\'ordre.',
      },
      {
        title: 'Suivi qualité, contrôles inopinés et reporting',
        text:
          'La qualité de la prestation est pilotée par des contrôles inopinés, des réunions de suivi périodiques et un reporting mensuel.\n' +
          'Les écarts éventuels font l\'objet d\'un plan d\'action correctif tracé.',
      },
    ],
  },
];

function sectionsToMarkdown(chapters: AssembleChapter[]): string {
  const out: string[] = ['# Mémoire technique GSS — sortie brute (Mode B sans template)', ''];
  chapters.forEach((c) => {
    out.push(`## ${c.key}. ${c.title}`, '');
    c.sections.forEach((s) => {
      out.push(`### ${s.title}`, '', s.text, '');
    });
  });
  return out.join('\n');
}

async function main() {
  const gen = new MemoireGenerator();
  const outDir = path.resolve(__dirname, '../../../data/output');
  fs.mkdirSync(outDir, { recursive: true });

  // Mode A — avec template refondu (fond gris, header conservé, images retirées)
  const withTpl = await gen.assembleFromSections('export', CHAPTERS);
  fs.copyFileSync(withTpl.filePath, path.join(outDir, 'v1_with_template.docx'));
  console.log('[gen_compare] Mode A (template refondu):', withTpl.generatedData);

  // Mode B — sans template (DOCX nu)
  const noTpl = await gen.assembleFromSections('export', CHAPTERS, { noTemplate: true });
  fs.copyFileSync(noTpl.filePath, path.join(outDir, 'v1_no_template.docx'));
  console.log('[gen_compare] Mode B (sans template):', noTpl.generatedData);

  // Sortie texte brute
  fs.writeFileSync(path.join(outDir, 'v1_no_template.md'), sectionsToMarkdown(CHAPTERS), 'utf8');

  // Nettoyage des copies horodatées dans response/
  [withTpl.filePath, noTpl.filePath].forEach((p) => { try { fs.unlinkSync(p); } catch {} });

  const sz = (f: string) => (fs.statSync(path.join(outDir, f)).size / 1024).toFixed(1) + ' Ko';
  console.log('[gen_compare] v1_with_template.docx =', sz('v1_with_template.docx'));
  console.log('[gen_compare] v1_no_template.docx   =', sz('v1_no_template.docx'));
}

main().catch((e) => { console.error(e); process.exit(1); });
