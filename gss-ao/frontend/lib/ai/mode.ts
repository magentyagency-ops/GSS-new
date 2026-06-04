/**
 * Mode de réponse du dossier (A = cadre imposé, B = réponse libre) + clés
 * localStorage partagées entre écran 3 (synthèse), /selection-slides, écran 5
 * et écran 6 (export).
 */

export type ResponseMode = "A" | "B";

export interface SlideRec {
  index: number;
  file_name: string;
  category: string;
  chapter: "I" | "II" | "III" | "IV";
  recommendation: "keep" | "modify" | "discard";
  justification: string;
}

const modeKey = (id: string) => `gss_mode_${id}`;
const slidesKey = (id: string) => `gss_slides_${id}`; // recommandations analysées
const selectedKey = (id: string) => `gss_selected_${id}`; // index sélectionnés
export const memoireBKey = (id: string) => `gss_memoire_b_${id}`; // textes générés Mode B

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function getMode(id: string): ResponseMode {
  if (typeof window === "undefined") return "A";
  return (localStorage.getItem(modeKey(id)) as ResponseMode) || "A";
}
export function setMode(id: string, mode: ResponseMode): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(modeKey(id), mode);
}

export const getAnalyzedSlides = (id: string): SlideRec[] => read(slidesKey(id), []);
export const setAnalyzedSlides = (id: string, slides: SlideRec[]): void =>
  write(slidesKey(id), slides);

export const getSelectedIndexes = (id: string): number[] => read(selectedKey(id), []);
export const setSelectedIndexes = (id: string, idx: number[]): void => write(selectedKey(id), idx);
