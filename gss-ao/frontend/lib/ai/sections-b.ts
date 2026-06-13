/**
 * Sections génériques GSS — MODE B (réponse libre), miroir frontend de
 * backend/ai/sections_b.py. Structure calquée sur AO RNE (Clarence).
 */

export interface AiSectionB {
  id: string;
  chapter: "I" | "II" | "III" | "IV";
  title: string;
}

export const CHAPTER_TITLES_B: Record<AiSectionB["chapter"], string> = {
  I: "Présentation de notre structure",
  II: "Les moyens humains",
  III: "Les moyens opérationnels",
  IV: "Les moyens organisationnels",
};

export const AI_SECTIONS_B: AiSectionB[] = [
  // ---- I — Présentation de notre structure ----
  { id: "b_presentation", chapter: "I", title: "Présentation de la société GSS" },
  { id: "b_implantation", chapter: "I", title: "Implantation régionale et agences de proximité" },
  { id: "b_agrements", chapter: "I", title: "Autorisations, agréments CNAPS et conformité légale" },
  { id: "b_engagement_rse", chapter: "I", title: "Engagement RSE et écologique" },
  // ---- II — Les moyens humains ----
  { id: "b_moyens_humains", chapter: "II", title: "Qualifications et profils des agents (CQP APS, SSIAP)" },
  { id: "b_encadrement", chapter: "II", title: "Encadrement et organigramme opérationnel" },
  { id: "b_reprise_personnel", chapter: "II", title: "Reprise du personnel en place (article L1224-1)" },
  { id: "b_recrutement_formation", chapter: "II", title: "Recrutement, formation et montée en compétences" },
  { id: "b_dispositif_absence", chapter: "II", title: "Dispositif palliatif d'absence et remplacement" },
  { id: "b_tenues_epi", chapter: "II", title: "Tenues et équipements de protection des agents" },
  // ---- III — Les moyens opérationnels ----
  { id: "b_moyens_materiels", chapter: "III", title: "Moyens matériels et équipements" },
  { id: "b_rondes", chapter: "III", title: "Rondes, pointeaux et main courante électronique" },
  { id: "b_controle_acces", chapter: "III", title: "Gestion des accès et contrôle des flux" },
  { id: "b_telesurveillance", chapter: "III", title: "Télésurveillance et levée de doute (lot 3)" },
  { id: "b_gestion_alarmes", chapter: "III", title: "Gestion des alarmes et procédures d'intervention" },
  // ---- IV — Les moyens organisationnels ----
  { id: "b_organisation", chapter: "IV", title: "Organisation et démarrage de la prestation" },
  { id: "b_planning", chapter: "IV", title: "Plannings et continuité de service" },
  { id: "b_suivi_qualite", chapter: "IV", title: "Suivi qualité, contrôles inopinés et reporting" },
  { id: "b_procedures", chapter: "IV", title: "Procédures opérationnelles et gestion des incidents" },
  { id: "b_amelioration", chapter: "IV", title: "Amélioration continue et bilan de prestation" },
];

export const AI_SECTIONS_B_BY_CHAPTER = AI_SECTIONS_B.reduce(
  (acc, s) => {
    (acc[s.chapter] ||= []).push(s);
    return acc;
  },
  {} as Record<AiSectionB["chapter"], AiSectionB[]>,
);
