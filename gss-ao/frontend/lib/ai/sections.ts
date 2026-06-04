/**
 * Catalogue des sous-sections générées par l'IA — MODE A (template imposé Univ Rouen).
 * Miroir frontend du catalogue backend (backend/ai/sections.py), enrichi du
 * contexte mock (extrait CCTP + chunks RAG) envoyé à /api/generate-section.
 *
 * Contexte = mock (cas Univ Rouen) ; le RAG réel (pgvector) est hors-scope.
 */

export interface AiRagChunk {
  categorie: string;
  source: string;
  texte: string;
}

export interface AiSection {
  id: string;
  chapter: "I" | "II" | "III" | "IV";
  title: string;
  points: number;
  cctpExtract: string;
  ragChunks: AiRagChunk[];
}

export const CHAPTER_TITLES: Record<AiSection["chapter"], string> = {
  I: "Moyens humains",
  II: "Moyens matériels",
  III: "Organisation & qualité",
  IV: "Télésurveillance (lot 3)",
};

export const AI_SECTIONS: AiSection[] = [
  // ---- I ----
  {
    id: "i_qualifications",
    chapter: "I",
    title: "Qualifications et expérience des moyens humains",
    points: 20,
    cctpExtract:
      "Le CCTP impose un chef d'équipe SSIAP2 coordinateur sûreté-sécurité et un adjoint, des agents APS titulaires de la carte CNAPS, SSIAP1 pour les postes incendie, et la reprise du personnel en place (art. L1224-1).",
    ragChunks: [
      { categorie: "Formation", source: "FORMATION AGENT SSIAP1 3.pdf", texte: "Cursus SSIAP1 et recyclage triennal des agents incendie." },
      { categorie: "Effectifs", source: "ORGANIGRAMME GSS.pdf", texte: "Organigramme opérationnel et effectifs par site." },
      { categorie: "Recrutement", source: "METHODE RECRUTEMENT 1.pdf", texte: "Sélection et vérification de la carte CNAPS." },
    ],
  },
  {
    id: "i_dispositif_absence",
    chapter: "I",
    title: "Dispositif palliatif d'absence",
    points: 20,
    cctpExtract:
      "Continuité de service exigée sur tous les postes, y compris en cas d'absence imprévue d'un agent.",
    ragChunks: [
      { categorie: "Absence et retard", source: "REMPLACEMENT AGENT 2.pdf", texte: "Procédure de remplacement < 1h via volant régional." },
      { categorie: "Planification", source: "GESTION PLANNING 1.pdf", texte: "Binômage et anticipation des congés." },
    ],
  },
  {
    id: "i_soustraitance_prestataires",
    chapter: "I",
    title: "Sous-traitance — prestataires habituels",
    points: 20,
    cctpExtract: "Le candidat précise le recours éventuel à la sous-traitance en Normandie.",
    ragChunks: [
      { categorie: "Partenaires", source: "PARTENAIRES NORMANDIE 3.pdf", texte: "Réseau de partenaires agréés en région Normandie." },
    ],
  },
  // ---- II ----
  {
    id: "ii_rondes",
    chapter: "II",
    title: "Rondes & report des incidents",
    points: 20,
    cctpExtract:
      "Rondes de protection du patrimoine avec contrôle (pointeaux) et report des incidents (photos, main courante).",
    ragChunks: [
      { categorie: "Main courante", source: "TRACK FORCE 1.pdf", texte: "Main courante électronique, pointeaux horodatés, reporting client." },
      { categorie: "Matériel", source: "MATERIEL COMMUNICATION 2.pdf", texte: "Dotation radio et PTI des agents." },
    ],
  },
  {
    id: "ii_localisation_agences",
    chapter: "II",
    title: "Localisation des agences & télégestion",
    points: 20,
    cctpExtract: "Agences et centres opérationnels dans les départements 76 et 27, moyens de liaison.",
    ragChunks: [
      { categorie: "Mise en place", source: "DEMARRAGE PRESTATION.pdf", texte: "Implantation locale et télégestion des équipes." },
    ],
  },
  {
    id: "ii_epi",
    chapter: "II",
    title: "Équipements de protection des agents",
    points: 20,
    cctpExtract: "Zones à régime restrictif (ZRR) ; risques d'agression sur certains postes.",
    ragChunks: [
      { categorie: "Tenues", source: "TENUE AGENT 1.pdf", texte: "Tenue GSS, EPI et équipements individuels." },
      { categorie: "Moyens d'accès", source: "SECURISATION ACCES 1.pdf", texte: "Gestion des accès en zone restreinte." },
    ],
  },
  // ---- III ----
  {
    id: "iii_qualite",
    chapter: "III",
    title: "Engagement qualité",
    points: 10,
    cctpExtract: "Plan qualité, contrôles, politique sociale limitant le turn-over, contrôle des prestations supplémentaires.",
    ragChunks: [
      { categorie: "Suivi qualité", source: "CONTROLES INOPINES 2.pdf", texte: "Plan de contrôle qualité et audits inopinés." },
      { categorie: "Management", source: "VALEURS MANAGMENT 1.pdf", texte: "Management de proximité et fidélisation des agents." },
    ],
  },
  {
    id: "iii_environnement",
    chapter: "III",
    title: "Performance environnementale",
    points: 10,
    cctpExtract: "Prise en compte du développement durable, flotte de véhicules.",
    ragChunks: [
      { categorie: "Engagement écologique", source: "DEMARCHE RSE 2.pdf", texte: "Flotte à faibles émissions, dématérialisation, démarche RSE." },
    ],
  },
  // ---- IV ----
  {
    id: "iv_localisation_station",
    chapter: "IV",
    title: "Localisation station télésurveillance",
    points: 40,
    cctpExtract: "Station de télésurveillance certifiée APSAD R31, couverture 76 et 27.",
    ragChunks: [
      { categorie: "Matériel", source: "MATERIEL TELESURVEILLANCE.pdf", texte: "Station APSAD R31 (P3) à Rouen, opérée 24/7." },
    ],
  },
  {
    id: "iv_report_alarmes",
    chapter: "IV",
    title: "Report des alarmes",
    points: 40,
    cctpExtract: "Report des alarmes intrusion, technique et incendie ; levée de doute.",
    ragChunks: [
      { categorie: "Procédure", source: "GESTION D'UNE INTERVENTION ALARME 1.pdf", texte: "Procédure d'intervention sur alarme, levée de doute vidéo." },
    ],
  },
  {
    id: "iv_moyens_ouverture",
    chapter: "IV",
    title: "Moyens d'ouverture (levée de doute)",
    points: 40,
    cctpExtract: "Moyens d'ouverture des locaux pour la levée de doute (clés, badges, codes).",
    ragChunks: [
      { categorie: "Moyens d'accès", source: "SECURISATION ACCES 1.pdf", texte: "Trousseaux sécurisés, coffre à clés normalisé sur site." },
    ],
  },
  {
    id: "iv_outils_reporting",
    chapter: "IV",
    title: "Outils de reporting numérique",
    points: 40,
    cctpExtract: "Outils de reporting numérique des intervenants ; point d'entrée unique.",
    ragChunks: [
      { categorie: "Main courante", source: "TRACK FORCE 1.pdf", texte: "Reporting numérique temps réel et extranet client." },
    ],
  },
];

export const AI_SECTIONS_BY_CHAPTER = AI_SECTIONS.reduce(
  (acc, s) => {
    (acc[s.chapter] ||= []).push(s);
    return acc;
  },
  {} as Record<AiSection["chapter"], AiSection[]>,
);
