"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  Circle,
  BookOpen,
  ExternalLink,
  AlertTriangle,
  Loader2,
  Cpu,
  FileStack,
  FileText,
  ArrowRight,
} from "lucide-react";
import { Badge, Button, Card, Progress } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { type DceFile } from "@/lib/gss-config";
import { AI_SECTIONS, CHAPTER_TITLES } from "@/lib/ai/sections";
import { DocxPreviewViewer } from "@/components/docx-preview-viewer";
import { AI_SECTIONS_B, CHAPTER_TITLES_B } from "@/lib/ai/sections-b";
import { generateSection, getApiKey, type RagChunk } from "@/lib/ai/client";
import {
  getMode,
  memoireBKey,
  getAnalyzedSlides,
  getSelectedIndexes,
  type ResponseMode,
} from "@/lib/ai/mode";
import { cn } from "@/lib/utils";
import { use } from "react";

interface GenEntry {
  text: string;
  model: string;
  tokens: number;
}
type GenMap = Record<string, GenEntry>;

// Section unifiée pour le rendu (Mode A et Mode B)
interface UISection {
  id: string;
  chapter: "I" | "II" | "III" | "IV";
  title: string;
  points?: number;
  cctpExtract?: string;
  ragChunks: RagChunk[];
}

const CHAPTERS: UISection["chapter"][] = ["I", "II", "III", "IV"];

export default function MemoirePage({ params }: { params: { id: string } }) {
  const id = params.id;
  const router = useRouter();
  const [mode, setMode] = useState<ResponseMode>("A");
  const [gen, setGen] = useState<GenMap>({});
  const [activeId, setActiveId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slidesByChapter, setSlidesByChapter] = useState<Record<string, RagChunk[]>>({});

  // States for full DOCX generation (Backend API)
  const [isGeneratingDocx, setIsGeneratingDocx] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [isAssembling, setIsAssembling] = useState(false);
  const [docxResult, setDocxResult] = useState<any>(null);

  // States for Prerequisite System (Required System)
  const [crFourni, setCrFourni] = useState(false);
  const isPrerequisOk = true; // CR requirement temporarily disabled

  const [dossierInfo, setDossierInfo] = useState<any>({ acheteur: "Chargement...", reference: "..." });
  const [hasTemplate, setHasTemplate] = useState(false);

  useEffect(() => {
    fetch(`http://localhost:8000/api/dossiers/${id}`)
      .then(res => res.json())
      .then(data => {
        if (!data.error) setDossierInfo(data);
      })
      .catch(e => console.error(e));
  }, [id]);

  useEffect(() => {
    // Detect template from dce_files stored in the dossier (API)
    if (dossierInfo?.dce_files && Array.isArray(dossierInfo.dce_files)) {
      const found = dossierInfo.dce_files.some((f: any) => f.type === "Mémoire (cadre)" && f.statut === "ok");
      setHasTemplate(found);
    } else {
      setHasTemplate(false);
    }
  }, [dossierInfo]);

  const storageKey = mode === "B" ? memoireBKey(id) : `gss_memoire_${id}`;

  // Sections selon le mode
  const sections: UISection[] = useMemo(() => {
    if (mode === "B") {
      return AI_SECTIONS_B.map((s) => ({
        id: s.id,
        chapter: s.chapter,
        title: s.title,
        ragChunks: slidesByChapter[s.chapter] || [],
      }));
    }
    return AI_SECTIONS.map((s) => ({
      id: s.id,
      chapter: s.chapter,
      title: s.title,
      points: s.points,
      cctpExtract: s.cctpExtract,
      ragChunks: s.ragChunks,
    }));
  }, [mode, slidesByChapter]);

  const chapterTitles = mode === "B" ? CHAPTER_TITLES_B : CHAPTER_TITLES;

  // Init (mode, clé, slides Mode B, état généré)
  useEffect(() => {
    const m = getMode(id);
    setMode(m);

    if (m === "B") {
      const all = getAnalyzedSlides(id);
      const sel = new Set(getSelectedIndexes(id));
      const byChap: Record<string, RagChunk[]> = {};
      all
        .filter((s) => sel.has(s.index))
        .forEach((s) => {
          (byChap[s.chapter] ||= []).push({
            categorie: s.category,
            source: s.file_name,
            texte: s.justification || "",
          });
        });
      setSlidesByChapter(byChap);
    }

    const key = mode === "B" ? memoireBKey(id) : `gss_memoire_${id}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw) setGen(JSON.parse(raw));

      // Vérifier si le CR a été fourni via l'upload d'un dossier DCE
      if (localStorage.getItem("gss_cr_fourni") === "true") {
        setCrFourni(true);
      }
    } catch {
      /* ignore */
    }
    setActiveId(m === "B" ? AI_SECTIONS_B[0].id : AI_SECTIONS[0].id);
  }, []);

  function persist(next: GenMap) {
    setGen(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  // Initialiser avec preview ou section 0
  const isPreview = activeId === "preview";
  const active = isPreview ? null : sections.find((s) => s.id === activeId) || sections[0];
  const current = active ? gen[active.id] : undefined;

  function handleEdit(text: string) {
    if (!active) return;
    const prev = gen[active.id];
    persist({ ...gen, [active.id]: { text, model: prev?.model || "édité", tokens: prev?.tokens || 0 } });
  }

  const generatedCount = sections.filter((s) => gen[s.id]?.text).length;
  const progressPct = sections.length ? Math.round((generatedCount / sections.length) * 100) : 0;
  const totalTokens = useMemo(
    () => Object.values(gen).reduce((a, g) => a + (g.tokens || 0), 0),
    [gen],
  );

  // Génère une section unique (mêmes paramètres que la boucle groupée).
  async function genOne(section: UISection): Promise<GenEntry> {
    const r = await generateSection({
      sectionId: section.id,
      cctpExtract: section.cctpExtract || "",
      ragChunks: mode === "A" ? section.ragChunks : [],
      templateQuestion: mode === "B" ? section.title : undefined,
      mode,
      selectedSlides: mode === "B" ? section.ragChunks : [],
    });
    return { text: r.generated_text, model: r.model, tokens: r.tokens_used };
  }

  // Réessaie un appel avec un petit backoff (utile pour le rate limit OpenAI).
  async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async function handleGenerate(section: UISection) {
    if (busyId) return;
    setBusyId(section.id);
    setError(null);
    try {
      persist({ ...gen, [section.id]: await genOne(section) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Génération échouée");
    } finally {
      setBusyId(null);
    }
  }

  // Génère toutes les sections SÉQUENTIELLEMENT (une après l'autre) pour rester
  // sous la limite OpenAI ~30k tokens/min : un Promise.all parallèle déclenche des
  // 429 silencieux et des sections vides.
  async function handleGenerateAllSections() {
    if (busyId || isGeneratingAll) return;
    setIsGeneratingAll(true);
    setError(null);
    let currentGen = { ...gen };
    const failed: string[] = [];

    for (const section of sections) {
      setBusyId(section.id);
      try {
        currentGen = { ...currentGen, [section.id]: await withRetry(() => genOne(section)) };
        persist(currentGen); // sauvegarde incrémentale après chaque section
      } catch {
        failed.push(section.title);
      }
    }

    setBusyId(null);
    setIsGeneratingAll(false);
    if (failed.length > 0) {
      setError(`Sections en échec : ${failed.join(", ")}`);
    }
  }

  // Assemble les sections générées dans le mémoire de référence GSS (AO RNE.docx),
  // en remplaçant le contenu de chaque chapitre, puis redirige vers l'export.
  async function handleAssembleAndExport() {
    if (isAssembling) return;
    // Construire la charge utile : 4 chapitres dans l'ordre I..IV, avec leurs
    // sections générées (texte non vide) ; un chapitre sans contenu est laissé tel quel.
    const chapters = CHAPTERS.map((ch) => ({
      key: ch,
      title: chapterTitles[ch],
      sections: sections
        .filter((s) => s.chapter === ch && gen[s.id]?.text?.trim())
        .map((s) => ({ title: s.title, text: gen[s.id].text })),
    }));

    if (chapters.every((c) => c.sections.length === 0)) {
      setError("Aucune section générée — générez d'abord le mémoire technique.");
      return;
    }

    setIsAssembling(true);
    setError(null);
    try {
      const res = await fetch(`http://localhost:8000/api/dossiers/${id}/memoire-from-sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapters }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Assemblage échoué");
      localStorage.setItem(`generated_docx_${id}`, data.file_path);
      router.push(`/dossiers/${id}/export`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assemblage du document échoué");
      setIsAssembling(false);
    }
  }



  async function handleGenerateFullDocx() {
    setIsGeneratingDocx(true);
    setDocxResult(null);
    try {
      const res = await fetch(`http://localhost:8000/api/dce/${id}/memoire`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur lors de la génération");
      setDocxResult({ type: "success", data });
      localStorage.setItem(`generated_docx_${id}`, data.file_path);
    } catch (e: any) {
      setDocxResult({ type: "error", message: e.message });
    } finally {
      setIsGeneratingDocx(false);
    }
  }

  if (!active) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {dossierInfo.acheteur} · {dossierInfo.reference}
            </div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              Mémoire technique — génération IA
              {mode === "B" ? (
                <Badge variant="warning">Réponse libre</Badge>
              ) : (
                <Badge variant="default">Cadre imposé</Badge>
              )}
            </h1>
          </div>
          {!hasTemplate && (
            <div className="flex items-center gap-5">
              {/* Métriques compactes */}
              <div className="hidden items-center gap-4 lg:flex">
                <div className="w-40">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Sections générées</span>
                    <span className="font-medium text-foreground">
                      {generatedCount}/{sections.length}
                    </span>
                  </div>
                  <Progress value={progressPct} />
                </div>
                <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  <Cpu className="h-3.5 w-3.5" /> {totalTokens.toLocaleString("fr-FR")} tokens
                </div>
              </div>

              <div className="hidden h-9 w-px bg-border lg:block" />

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleGenerateAllSections}
                  disabled={isGeneratingAll || busyId !== null}
                  title="Générer automatiquement toutes les sections, l'une après l'autre"
                >
                  {isGeneratingAll ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-4 w-4" />
                  )}
                  {isGeneratingAll ? "Génération…" : "Générer tout"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAssembleAndExport}
                  disabled={isAssembling || generatedCount === 0}
                  title="Assembler le mémoire dans le modèle GSS puis passer à l'export du .docx final"
                >
                  {isAssembling ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FileText className="mr-2 h-4 w-4" />
                  )}
                  Exporter
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </header>

      {mode === "A" && !isPrerequisOk && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-800">Prérequis manquants pour générer le document</h3>
              <p className="text-sm text-amber-700 mt-1">L'IA ne peut pas générer un mémoire pertinent si les informations terrain sont manquantes. Ce dossier exige une visite obligatoire.</p>
              <ul className="mt-3 space-y-2 text-sm text-amber-800">
                <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Analyse du DCE (CCTP & RC)</li>
                <li className="flex items-center gap-2">
                  {crFourni ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-amber-500" />}
                  Compte Rendu de Visite de Sacha
                  {!crFourni && (
                    <Button variant="outline" size="sm" className="ml-3 h-7 bg-white text-xs" onClick={() => setCrFourni(true)}>
                      Simuler l'ajout du CR
                    </Button>
                  )}
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {!hasTemplate && docxResult && (
        <div className={cn("px-6 py-3 text-sm", docxResult.type === "success" ? "bg-emerald-50 text-emerald-800 border-b border-emerald-200" : "bg-red-50 text-red-800 border-b border-red-200")}>
          {docxResult.type === "success" ? (
            <div className="flex flex-col gap-1">
              <strong className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Document généré avec succès !</strong>
              <span>Enregistré sous : <code>{docxResult.data.file_path}</code></span>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer underline">Voir les modifications d'IA</summary>
                <pre className="mt-2 bg-emerald-900 text-emerald-50 p-3 rounded-md overflow-x-auto">
                  {JSON.stringify(JSON.parse(docxResult.data.data_generee_par_ia.details), null, 2)}
                </pre>
              </details>
            </div>
          ) : (
            <strong>Erreur: {docxResult.message}</strong>
          )}
        </div>
      )}

      <DossierNav id={id} />

      {hasTemplate ? (
        <div className="flex flex-1 flex-col items-center justify-start overflow-y-auto bg-muted/10 p-8">
          <div className="w-full max-w-4xl space-y-6">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <FileText className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">Génération par Template</h1>
              <p className="mt-2 text-muted-foreground">
                Ce dossier contient un cadre de réponse imposé par le marché (Mémoire technique). L'IA lit le document complet pour y insérer directement les éléments adaptés (cocher des cases, remplir des champs spécifiques).
              </p>

              <div className="mt-6">
                <Button
                  size="lg"
                  onClick={handleGenerateFullDocx}
                  disabled={isGeneratingDocx || !isPrerequisOk}
                  className={cn(
                    "w-full max-w-md transition-all",
                    isPrerequisOk ? "bg-indigo-600 hover:bg-indigo-700" : "bg-indigo-300 cursor-not-allowed"
                  )}
                >
                  {isGeneratingDocx ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <FileStack className="mr-2 h-5 w-5" />}
                  {isGeneratingDocx ? "Génération et analyse en cours..." : "Lancer la génération du document complet"}
                </Button>
                {!isPrerequisOk && <p className="mt-2 text-xs text-amber-600">Prérequis manquants (CR Visite)</p>}
              </div>
            </div>

            {docxResult && docxResult.type === "success" && (
              <Card className="mt-8 overflow-hidden border-emerald-200">
                <div className="bg-emerald-50 px-6 py-4 border-b border-emerald-100 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                    <CheckCircle2 className="h-5 w-5" />
                    <span>Document généré avec succès !</span>
                  </div>
                  <Link href={`/dossiers/${id}/export`}>
                    <Button variant="default" size="sm" className="bg-emerald-600 hover:bg-emerald-700">
                      Continuer vers l'Export <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Link>
                </div>

                <div className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-medium text-foreground">Prévisualisation des modifications de l'IA :</h3>
                    <Badge variant="secondary">{JSON.parse(docxResult.data.data_generee_par_ia.details).length} remplacements</Badge>
                  </div>
                  <div className="space-y-4">
                    {JSON.parse(docxResult.data.data_generee_par_ia.details).map((mod: any, idx: number) => (
                      <div key={idx} className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 bg-card">
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-muted-foreground mb-1">Texte original (Recherche)</div>
                          <div className="bg-red-50 text-red-900 px-3 py-2 rounded text-sm font-mono border border-red-100 whitespace-pre-wrap break-all line-through opacity-70">
                            {mod.recherche}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase text-muted-foreground mb-1">Proposition IA (Remplacement)</div>
                          <div className="bg-emerald-50 text-emerald-900 px-3 py-2 rounded text-sm font-mono border border-emerald-100 whitespace-pre-wrap break-all">
                            {mod.remplacement}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Prévisualisation Complète du DOCX */}
                  <div className="mt-12 pt-8 border-t border-slate-200">
                    <h3 className="font-medium text-lg text-slate-800 mb-2">Aperçu du document final (De A à Z)</h3>
                    <p className="text-sm text-slate-500 mb-4">Voici le rendu interactif du fichier DOCX tel qu'il a été généré, avec le formatage d'origine conservé.</p>
                    <DocxPreviewViewer fileUrl={`http://localhost:8000/api/download?file=${encodeURIComponent(docxResult.data.file_path)}`} />
                  </div>
                </div>
              </Card>
            )}

            {docxResult && docxResult.type === "error" && (
              <div className="mt-8 p-4 bg-red-50 text-red-800 rounded-md border border-red-200">
                <strong>Erreur lors de la génération :</strong> {docxResult.message}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={cn("grid flex-1 overflow-hidden", isPreview ? "grid-cols-[260px_1fr]" : "grid-cols-[260px_1fr_300px]")}>
          {/* Sommaire */}
          <aside className="overflow-y-auto border-r border-border bg-card p-3">
            <button
              onClick={() => setActiveId("preview")}
              className={cn(
                "mb-4 flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                isPreview ? "bg-primary text-primary-foreground border-primary" : "bg-muted/50 hover:bg-muted"
              )}
            >
              <FileText className="h-4 w-4" /> Prévisualisation globale
            </button>
            {CHAPTERS.map((ch) => {
              const chapSections = sections.filter((s) => s.chapter === ch);
              if (chapSections.length === 0) return null;
              return (
                <div key={ch} className="mb-3">
                  <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {ch}. {chapterTitles[ch]}
                  </div>
                  <div className="space-y-0.5">
                    {chapSections.map((s) => {
                      const done = !!gen[s.id]?.text;
                      const isActive = s.id === activeId;
                      const isBusy = busyId === s.id;
                      return (
                        <button
                          key={s.id}
                          onClick={() => setActiveId(s.id)}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                          )}
                        >
                          {isBusy ? (
                            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                          ) : done ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                          ) : (
                            <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex-1">{s.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </aside>

          {/* Éditeur */}
          <section className="flex flex-col overflow-y-auto">
            {isPreview ? (
              <div className="flex-1 bg-muted/20 p-8">
                <div className="mx-auto max-w-4xl space-y-8 rounded-xl border border-border bg-card p-10 shadow-sm">
                  <div className="border-b border-border pb-6 text-center">
                    <h1 className="text-3xl font-bold text-primary">Prévisualisation du Mémoire</h1>
                    <p className="mt-2 text-sm text-muted-foreground">Version générée pour {dossierInfo.acheteur}</p>
                  </div>
                  {CHAPTERS.map(ch => {
                    const chapSections = sections.filter(s => s.chapter === ch);
                    if (chapSections.length === 0) return null;
                    return (
                      <div key={ch} className="space-y-6">
                        <h2 className="text-xl font-bold border-b border-border pb-2">{ch}. {chapterTitles[ch]}</h2>
                        {chapSections.map(s => {
                          const content = gen[s.id]?.text;
                          return (
                            <div key={s.id} className="space-y-3">
                              <h3 className="text-lg font-semibold">{s.title}</h3>
                              {content ? (
                                <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{content}</div>
                              ) : (
                                <div className="rounded-md border border-dashed border-border bg-muted/10 p-4 text-center text-sm text-muted-foreground italic">
                                  [Section non générée — {s.title}]
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : active ? (
              <>
                <div className="flex items-center justify-between border-b border-border px-6 py-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Chapitre {active.chapter}</Badge>
                    <h2 className="text-base font-semibold">{active.title}</h2>
                  </div>
                  {active.points != null && <Badge variant="outline">{active.points} pts</Badge>}
                </div>

                {error && busyId === null && (
                  <div className="mx-6 mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                {!current ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                    <Sparkles className="h-10 w-10 text-primary" />
                    <div>
                      <div className="text-base font-semibold">Section non générée</div>
                      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                        {mode === "B"
                          ? "L'IA rédige cette section à partir des slides GSS sélectionnées et du contexte du marché."
                          : "L'IA rédige cette section à partir de la question imposée, de l'extrait CCTP et des contenus GSS."}
                      </p>
                    </div>
                    <Button size="lg" onClick={() => handleGenerate(active)} disabled={busyId !== null}>
                      {busyId === active.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      Générer cette section avec l'IA
                    </Button>
                    {mode === "B" && active.ragChunks.length === 0 && (
                      <p className="text-xs text-amber-700">
                        Aucune slide sélectionnée pour ce chapitre —{" "}
                        <Link href={`/dossiers/${id}/selection-slides`} className="underline">
                          sélectionner des slides
                        </Link>
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-6 py-2">
                      <Badge variant="secondary" className="gap-1">
                        <Sparkles className="h-3 w-3" /> Généré par l'IA
                      </Badge>
                      <span className="text-xs text-muted-foreground">Texte éditable librement.</span>
                    </div>
                    <textarea
                      value={current.text}
                      onChange={(e) => handleEdit(e.target.value)}
                      className="flex-1 resize-none bg-background px-6 py-5 text-[15px] leading-7 text-foreground outline-none"
                      spellCheck={false}
                    />
                    <div className="flex items-center justify-between border-t border-border bg-card px-6 py-3">
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Cpu className="h-3.5 w-3.5" /> {current.model}
                        </span>
                        <span>{current.tokens.toLocaleString("fr-FR")} tokens</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGenerate(active)}
                        disabled={busyId !== null}
                      >
                        {busyId === active.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Régénérer
                      </Button>
                    </div>
                  </>
                )}
              </>
            ) : null}
          </section>

          {/* Sources */}
          {!isPreview && active && (
            <aside className="overflow-y-auto border-l border-border bg-card p-4">
              {mode === "B" ? (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <FileStack className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold">Slides sources</span>
                  </div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Slides sélectionnées pour le chapitre {active.chapter}.
                  </p>
                  {active.ragChunks.length === 0 ? (
                    <Card className="p-3 text-xs text-muted-foreground">
                      Aucune slide.{" "}
                      <Link href={`/dossiers/${id}/selection-slides`} className="text-primary underline">
                        Sélectionner
                      </Link>
                    </Card>
                  ) : (
                    <div className="space-y-2">
                      {active.ragChunks.map((src, i) => (
                        <Card key={i} className="p-3">
                          <Badge variant="secondary" className="mb-1 font-normal">
                            {src.categorie}
                          </Badge>
                          <div className="truncate text-xs font-medium" title={src.source}>
                            {src.source}
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold">Sources mobilisées</span>
                  </div>
                  <p className="mb-2 text-xs text-muted-foreground">Extrait CCTP</p>
                  <Card className="mb-3 p-3 text-xs text-muted-foreground">{active.cctpExtract}</Card>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Base <span className="font-medium">SLIDE REP AO</span>
                  </p>
                  <div className="space-y-2">
                    {active.ragChunks.map((src, i) => (
                      <Card key={i} className="p-3">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <Badge variant="secondary" className="font-normal">
                            {src.categorie}
                          </Badge>
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <div className="truncate text-xs font-medium" title={src.source}>
                          {src.source}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{src.texte}</p>
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
