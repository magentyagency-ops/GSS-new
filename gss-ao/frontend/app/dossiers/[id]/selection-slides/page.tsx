"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Search,
  Loader2,
  ArrowRight,
  AlertTriangle,
  FileStack,
  Square,
  SquareCheck,
} from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { ROUEN } from "@/lib/mock-data";
import { analyzeSlides, getApiKey, type SlideRec } from "@/lib/ai/client";
import {
  getAnalyzedSlides,
  setAnalyzedSlides,
  getSelectedIndexes,
  setSelectedIndexes,
} from "@/lib/ai/mode";
import { CHAPTER_TITLES_B } from "@/lib/ai/sections-b";
import { cn } from "@/lib/utils";

const CHAPTERS = ["all", "I", "II", "III", "IV"] as const;
type ChapFilter = (typeof CHAPTERS)[number];
const TOTAL_SLIDES = 118;

const RECO_BADGE: Record<SlideRec["recommendation"], { label: string; variant: "success" | "warning" | "secondary" }> = {
  keep: { label: "Conservée", variant: "success" },
  modify: { label: "À personnaliser", variant: "warning" },
  discard: { label: "Exclue", variant: "secondary" },
};

export default function SelectionSlidesPage() {
  const [slides, setSlides] = useState<SlideRec[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chap, setChap] = useState<ChapFilter>("all");
  const [query, setQuery] = useState("");
  const [hasKey, setHasKey] = useState(true);

  useEffect(() => {
    setHasKey(!!getApiKey());
    setSlides(getAnalyzedSlides(ROUEN.id));
    setSelected(getSelectedIndexes(ROUEN.id));
  }, []);

  async function runAnalysis() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await analyzeSlides({
        cctpExtract:
          "Prestations de sécurité-sûreté sur 6 campus de l'Université de Rouen Normandie (76 et 27), reprise du personnel, chef d'équipe SSIAP2, télésurveillance lot 3.",
        proposalStrengths: [
          "Reprise du personnel garantie (L1224-1)",
          "Encadrement SSIAP2 dédié",
          "Main courante électronique Track Force",
        ],
        siteContext: "Université de Rouen Normandie — 6 campus, ZRR, rondes et télésurveillance.",
      });
      setSlides(r.slides);
      setAnalyzedSlides(ROUEN.id, r.slides);
      const pre = r.slides
        .filter((s) => s.recommendation === "keep" || s.recommendation === "modify")
        .map((s) => s.index);
      setSelected(pre);
      setSelectedIndexes(ROUEN.id, pre);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyse échouée");
    } finally {
      setBusy(false);
    }
  }

  function toggle(index: number) {
    const next = selected.includes(index)
      ? selected.filter((i) => i !== index)
      : [...selected, index];
    setSelected(next);
    setSelectedIndexes(ROUEN.id, next);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: slides.length, I: 0, II: 0, III: 0, IV: 0 };
    slides.forEach((s) => (c[s.chapter] = (c[s.chapter] || 0) + 1));
    return c;
  }, [slides]);

  const recommended = slides.filter(
    (s) => s.recommendation === "keep" || s.recommendation === "modify",
  ).length;

  const visible = slides.filter((s) => {
    if (chap !== "all" && s.chapter !== chap) return false;
    if (query) {
      const q = query.toLowerCase();
      return s.file_name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {ROUEN.acheteur} · {ROUEN.reference} · Mode réponse libre
          </div>
          <h1 className="text-xl font-semibold">Sélection des slides GSS</h1>
        </div>
        <Link href={`/dossiers/${ROUEN.id}/memoire`}>
          <Button disabled={selected.length === 0}>
            Valider la sélection ({selected.length}) <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </header>

      <DossierNav id={ROUEN.id} />

      {slides.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <FileStack className="h-12 w-12 text-primary" />
          <div>
            <div className="text-base font-semibold">Analyser les {TOTAL_SLIDES} slides GSS</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              L'IA recommande, pour ce marché, quelles slides de la base SLIDE REP AO conserver,
              personnaliser ou exclure (par lots de 15 pour économiser les tokens).
            </p>
          </div>
          {!hasKey && (
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4" /> Clé OpenAI requise —{" "}
              <Link href="/parametres" className="underline">
                Paramètres
              </Link>
            </div>
          )}
          <Button size="lg" onClick={runAnalysis} disabled={busy || !hasKey}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Lancer l'analyse IA des slides
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      ) : (
        <>
          {/* Stats + filtres */}
          <div className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-3">
            <div className="flex items-center gap-1">
              {CHAPTERS.map((c) => (
                <button
                  key={c}
                  onClick={() => setChap(c)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    chap === c
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c === "all" ? "Toutes" : c} ({counts[c] || 0})
                </button>
              ))}
            </div>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher (mot-clé, catégorie)…"
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-6 py-2 text-sm">
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{recommended}</span> slides
              recommandées sur {TOTAL_SLIDES} ·{" "}
              {chap === "all"
                ? "tous chapitres"
                : CHAPTER_TITLES_B[chap as keyof typeof CHAPTER_TITLES_B]}
            </span>
            <span className="font-medium">{selected.length} sélectionnées</span>
          </div>

          {/* Grille */}
          <div className="grid flex-1 grid-cols-3 content-start gap-3 overflow-y-auto p-6">
            {visible.map((s) => {
              const isSel = selected.includes(s.index);
              const reco = RECO_BADGE[s.recommendation];
              return (
                <Card
                  key={s.index}
                  onClick={() => toggle(s.index)}
                  className={cn(
                    "cursor-pointer p-3 transition-colors",
                    isSel ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40",
                  )}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <Badge variant="secondary" className="font-normal">
                      {s.category}
                    </Badge>
                    {isSel ? (
                      <SquareCheck className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="truncate text-xs font-medium" title={s.file_name}>
                    {s.file_name}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <Badge variant={reco.variant} className="font-normal">
                      {reco.label}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">Ch. {s.chapter}</span>
                  </div>
                  {s.justification && (
                    <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground" title={s.justification}>
                      💡 {s.justification}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
