"use client";

import { useMemo, useState } from "react";
import {
  Sparkles,
  Shuffle,
  CheckCircle2,
  Circle,
  ExternalLink,
  BookOpen,
  Target,
  Save,
} from "lucide-react";
import { Badge, Button, Card, Progress, Separator } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { MEMOIRE_SECTIONS, ROUEN, SCORE_TECHNIQUE } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

export default function MemoirePage() {
  const [sections, setSections] = useState(MEMOIRE_SECTIONS);
  const [activeId, setActiveId] = useState(MEMOIRE_SECTIONS[0].id);
  const active = sections.find((s) => s.id === activeId)!;

  const totalPoints = useMemo(
    () => sections.reduce((acc, s) => acc + s.points, 0),
    [sections],
  );
  const validatedPoints = useMemo(
    () => sections.filter((s) => s.statut === "validee").reduce((a, s) => a + s.points, 0),
    [sections],
  );
  const validatedCount = sections.filter((s) => s.statut === "validee").length;
  const progressPct = Math.round((validatedCount / sections.length) * 100);
  const scoreVise = Math.round((validatedPoints / totalPoints) * SCORE_TECHNIQUE);

  function updateContenu(value: string) {
    setSections((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, contenu: value, statut: "draft" as const } : s,
      ),
    );
  }
  function toggleValidee() {
    setSections((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? { ...s, statut: s.statut === "validee" ? "draft" : "validee" }
          : s,
      ),
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ---------- En-tête ---------- */}
      <header className="border-b border-border bg-card px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {ROUEN.acheteur} · {ROUEN.reference}
            </div>
            <h1 className="text-lg font-semibold">Mémoire technique — cadre imposé</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Target className="h-3.5 w-3.5" /> Score technique visé
              </div>
              <div className="text-sm font-semibold">
                <span className="text-primary">{scoreVise}</span> / {SCORE_TECHNIQUE} pts
              </div>
            </div>
            <Separator orientation="vertical" className="h-9" />
            <div className="w-44">
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>Avancement</span>
                <span className="font-medium text-foreground">
                  {validatedCount}/{sections.length} validées
                </span>
              </div>
              <Progress value={progressPct} />
            </div>
            <Button size="sm">
              <Save className="h-4 w-4" /> Enregistrer
            </Button>
          </div>
        </div>
      </header>

      <DossierNav id={ROUEN.id} />

      {/* ---------- 3 colonnes ---------- */}
      <div className="grid flex-1 grid-cols-[240px_1fr_300px] overflow-hidden">
        {/* Colonne gauche : sommaire */}
        <aside className="overflow-y-auto border-r border-border bg-card p-3">
          <div className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sommaire
          </div>
          <div className="space-y-1">
            {sections.map((s) => {
              const isActive = s.id === activeId;
              const done = s.statut === "validee";
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1">
                    <span className="font-medium">{s.num}.</span> {s.titre}
                    <span className="mt-1 flex items-center gap-1.5">
                      <Badge variant="secondary" className="font-normal">
                        {s.points} pts
                      </Badge>
                      {s.lots.length > 0 && (
                        <span className="text-[11px] text-muted-foreground">
                          Lots {s.lots.join(", ")}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Colonne centrale : éditeur */}
        <section className="flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between border-b border-border px-6 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">
                {active.num}. {active.titre}
              </h2>
              {active.statut === "validee" ? (
                <Badge variant="success">Validée</Badge>
              ) : (
                <Badge variant="warning">Brouillon</Badge>
              )}
            </div>
            <Badge variant="outline">{active.points} pts</Badge>
          </div>

          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-6 py-2">
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="h-3 w-3" /> Pré-rédigé par l'IA
            </Badge>
            <span className="text-xs text-muted-foreground">
              Texte généré à partir des sources RAG — éditable librement.
            </span>
          </div>

          {/* Éditeur (textarea stylisé — TipTap branché au Module C) */}
          <textarea
            value={active.contenu}
            onChange={(e) => updateContenu(e.target.value)}
            className="flex-1 resize-none bg-background px-6 py-5 text-[15px] leading-7 text-foreground outline-none placeholder:text-muted-foreground"
            spellCheck={false}
          />

          <div className="flex items-center justify-between border-t border-border bg-card px-6 py-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">
                <Sparkles className="h-4 w-4" /> Régénérer
              </Button>
              <Button variant="outline" size="sm">
                <Shuffle className="h-4 w-4" /> Variante
              </Button>
            </div>
            <Button
              size="sm"
              variant={active.statut === "validee" ? "secondary" : "default"}
              onClick={toggleValidee}
            >
              <CheckCircle2 className="h-4 w-4" />
              {active.statut === "validee" ? "Dévalider" : "Marquer validée"}
            </Button>
          </div>
        </section>

        {/* Colonne droite : sources RAG */}
        <aside className="overflow-y-auto border-l border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Sources RAG mobilisées</span>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Slides de la base <span className="font-medium">SLIDE REP AO</span> utilisées
            pour cette section.
          </p>
          <div className="space-y-2">
            {active.sources.map((src, i) => (
              <Card key={i} className="p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Badge variant="secondary" className="font-normal">
                    {src.categorie}
                  </Badge>
                  <button
                    className="text-muted-foreground hover:text-primary"
                    title="Ouvrir la slide"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="truncate text-xs font-medium" title={src.fichier}>
                  {src.fichier}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{src.extrait}</p>
              </Card>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
