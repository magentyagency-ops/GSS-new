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
  { id: "b_presentation", chapter: "I", title: "Présentation de la société GSS" },
  { id: "b_engagement_rse", chapter: "I", title: "Engagement RSE et écologique" },
  { id: "b_moyens_humains", chapter: "II", title: "Moyens humains" },
  { id: "b_moyens_materiels", chapter: "III", title: "Moyens matériels et opérationnels" },
  { id: "b_organisation", chapter: "IV", title: "Organisation et suivi qualité" },
  { id: "b_procedures", chapter: "IV", title: "Procédures opérationnelles" },
];

export const AI_SECTIONS_B_BY_CHAPTER = AI_SECTIONS_B.reduce(
  (acc, s) => {
    (acc[s.chapter] ||= []).push(s);
    return acc;
  },
  {} as Record<AiSectionB["chapter"], AiSectionB[]>,
);
