/**
 * Client des endpoints IA du backend FastAPI (Module C).
 * Base URL configurable via NEXT_PUBLIC_API_BASE (défaut http://localhost:8000).
 * La clé OpenAI est lue dans localStorage ("openai_api_key", BYO-key).
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8000";

export const OPENAI_KEY_STORAGE = "openai_api_key";

export function getApiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(OPENAI_KEY_STORAGE) || "";
}

export function setApiKey(key: string): void {
  if (typeof window === "undefined") return;
  if (key) localStorage.setItem(OPENAI_KEY_STORAGE, key);
  else localStorage.removeItem(OPENAI_KEY_STORAGE);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Backend injoignable (${API_BASE}). Lancez le serveur : uvicorn backend.main:app --port 8000`,
    );
  }
  if (!res.ok) {
    let msg = `Erreur ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || j.detail || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface RagChunk {
  categorie: string;
  source: string;
  texte: string;
}

export interface GenerateResult {
  generated_text: string;
  model: string;
  tokens_used: number;
}

export async function testKey(apiKey: string): Promise<boolean> {
  const r = await postJson<{ valid: boolean }>("/api/test-key", { api_key: apiKey });
  return r.valid;
}

export async function generateSection(params: {
  sectionId: string;
  cctpExtract: string;
  ragChunks: RagChunk[];
  templateQuestion?: string;
  mode?: "A" | "B";
  selectedSlides?: RagChunk[];
}): Promise<GenerateResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Clé API OpenAI non saisie (voir Paramètres).");
  return postJson<GenerateResult>("/api/generate-section", {
    api_key: apiKey,
    section_id: params.sectionId,
    cctp_extract: params.cctpExtract,
    rag_chunks: params.ragChunks,
    template_question: params.templateQuestion,
    mode: params.mode || "A",
    selected_slides: params.selectedSlides || [],
  });
}

export interface SlideRec {
  index: number;
  file_name: string;
  category: string;
  chapter: "I" | "II" | "III" | "IV";
  recommendation: "keep" | "modify" | "discard";
  justification: string;
}

/** MODE B — recommandation IA des slides SLIDE REP AO à inclure. */
export async function analyzeSlides(params: {
  cctpExtract: string;
  proposalStrengths: string[];
  siteContext: string;
}): Promise<{ slides: SlideRec[]; total: number }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Clé API OpenAI non saisie (voir Paramètres).");
  return postJson("/api/analyze-slides", {
    api_key: apiKey,
    cctp_extract: params.cctpExtract,
    proposal_strengths: params.proposalStrengths,
    site_context: params.siteContext,
  });
}

/** Appelle /api/export-docx et déclenche le téléchargement du .docx (Mode A ou B). */
export async function exportDocx(params: {
  sections: Record<string, string>;
  filename: string;
  mode?: "A" | "B";
  identite?: { denomination: string; num_cnaps: string; date_autorisation: string };
  signataire?: string;
  dateSignature?: string;
  selectedSlides?: { index: number; file_name: string; category: string; chapter: string }[];
  projet?: string;
  acheteur?: string;
}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/export-docx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sections: params.sections,
        mode: params.mode || "A",
        identite: params.identite,
        signataire: params.signataire,
        date_signature: params.dateSignature,
        selected_slides: params.selectedSlides || [],
        projet: params.projet || "Mémoire technique",
        acheteur: params.acheteur || "",
      }),
    });
  } catch {
    throw new Error(`Backend injoignable (${API_BASE}).`);
  }
  if (!res.ok) throw new Error(`Export DOCX échoué (${res.status}).`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = params.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
