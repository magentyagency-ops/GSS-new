"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
} from "lucide-react";
import { Badge, Button, Card, Progress } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { ROUEN } from "@/lib/mock-data";
import { AI_SECTIONS, CHAPTER_TITLES } from "@/lib/ai/sections";
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

export default function MemoirePage() {
  const [mode, setMode] = useState<ResponseMode>("A");
  const [gen, setGen] = useState<GenMap>({});
  const [activeId, setActiveId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [slidesByChapter, setSlidesByChapter] = useState<Record<string, RagChunk[]>>({});

  const storageKey = mode === "B" ? memoireBKey(ROUEN.id) : `gss_memoire_${ROUEN.id}`;

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
    const m = getMode(ROUEN.id);
    setMode(m);
    setHasKey(!!getApiKey());

    if (m === "B") {
      const all = getAnalyzedSlides(ROUEN.id);
      const sel = new Set(getSelectedIndexes(ROUEN.id));
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

    const key = m === "B" ? memoireBKey(ROUEN.id) : `gss_memoire_${ROUEN.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw) setGen(JSON.parse(raw));
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

  const active = sections.find((s) => s.id === activeId) || sections[0];
  const current = active ? gen[active.id] : undefined;
  const generatedCount = sections.filter((s) => gen[s.id]?.text).length;
  const progressPct = sections.length ? Math.round((generatedCount / sections.length) * 100) : 0;
  const totalTokens = useMemo(
    () => Object.values(gen).reduce((a, g) => a + (g.tokens || 0), 0),
    [gen],
  );

  async function handleGenerate(section: UISection) {
    if (busyId) return;
    setBusyId(section.id);
    setError(null);
    try {
      const r = await generateSection({
        sectionId: section.id,
        cctpExtract: section.cctpExtract || "",
        ragChunks: mode === "A" ? section.ragChunks : [],
        templateQuestion: mode === "B" ? section.title : undefined,
        mode,
        selectedSlides: mode === "B" ? section.ragChunks : [],
      });
      persist({ ...gen, [section.id]: { text: r.generated_text, model: r.model, tokens: r.tokens_used } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Génération échouée");
    } finally {
      setBusyId(null);
    }
  }

  function handleEdit(text: string) {
    if (!active) return;
    const prev = gen[active.id];
    persist({ ...gen, [active.id]: { text, model: prev?.model || "édité", tokens: prev?.tokens || 0 } });
  }

  if (!active) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {ROUEN.acheteur} · {ROUEN.reference}
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
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" /> {totalTokens.toLocaleString("fr-FR")} tokens
            </div>
            <div className="w-48">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>Sections générées</span>
                <span className="font-medium text-foreground">
                  {generatedCount}/{sections.length}
                </span>
              </div>
              <Progress value={progressPct} />
            </div>
          </div>
        </div>
      </header>

      <DossierNav id={ROUEN.id} />

      {!hasKey && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Clé OpenAI non configurée — la génération est désactivée.
          <Link href="/parametres" className="font-medium underline">
            Configurer dans Paramètres
          </Link>
        </div>
      )}

      <div className="grid flex-1 grid-cols-[260px_1fr_300px] overflow-hidden">
        {/* Sommaire */}
        <aside className="overflow-y-auto border-r border-border bg-card p-3">
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
              <Button size="lg" onClick={() => handleGenerate(active)} disabled={!hasKey || busyId !== null}>
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
                  <Link href={`/dossiers/${ROUEN.id}/selection-slides`} className="underline">
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
                  disabled={!hasKey || busyId !== null}
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
        </section>

        {/* Sources */}
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
                  <Link href={`/dossiers/${ROUEN.id}/selection-slides`} className="text-primary underline">
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
      </div>
    </div>
  );
}
