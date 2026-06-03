"use client";

import { useState } from "react";
import Link from "next/link";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Trash2,
  Sparkles,
} from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { DCE_FILES, ROUEN, type DceFile } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const TYPES = ["RC", "CCAP", "CCTP", "BPU / DPGF", "Mémoire (cadre)", "Acte d'Engagement", "Annexe", "Inconnu"];

export default function NouveauDossierPage() {
  const [files, setFiles] = useState<DceFile[]>(DCE_FILES);
  const [dragOver, setDragOver] = useState(false);

  const tousParses = files.every((f) => f.statut === "ok");
  const enCours = files.filter((f) => f.statut === "parsing").length;

  function terminerParsing() {
    setFiles((prev) => prev.map((f) => (f.statut === "parsing" ? { ...f, statut: "ok" } : f)));
  }
  function setType(nom: string, type: string) {
    setFiles((prev) => prev.map((f) => (f.nom === nom ? { ...f, type } : f)));
  }
  function remove(nom: string) {
    setFiles((prev) => prev.filter((f) => f.nom !== nom));
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-xl font-semibold">Nouveau dossier — dépôt du DCE</h1>
        <p className="text-sm text-muted-foreground">
          Déposez l'ensemble des pièces du Dossier de Consultation (PDF, DOCX, DOC). Le type de
          chaque pièce est détecté automatiquement.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            className={cn(
              "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
              dragOver ? "border-primary bg-accent" : "border-border bg-card",
            )}
          >
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div className="text-sm font-medium">Glissez-déposez les fichiers du DCE ici</div>
            <div className="mt-1 text-xs text-muted-foreground">
              ou cliquez pour parcourir — PDF, DOCX, DOC (multi-fichiers, ZIP accepté)
            </div>
            <Button variant="outline" size="sm" className="mt-4">
              Parcourir les fichiers
            </Button>
          </div>

          {/* Liste fichiers */}
          <Card>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="text-sm font-semibold">{files.length} fichiers déposés</div>
              {enCours > 0 && (
                <Button size="sm" variant="outline" onClick={terminerParsing}>
                  <Loader2 className="h-4 w-4 animate-spin" /> {enCours} en cours — terminer le
                  parsing
                </Button>
              )}
            </div>
            <div className="divide-y divide-border">
              {files.map((f) => (
                <div key={f.nom} className="flex items-center gap-3 px-4 py-2.5">
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{f.nom}</div>
                    <div className="text-xs text-muted-foreground">{f.taille}</div>
                  </div>

                  {/* Type détecté (éditable) */}
                  <select
                    value={f.type}
                    onChange={(e) => setType(f.nom, e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>

                  {/* Statut parsing */}
                  <div className="w-24 text-right">
                    {f.statut === "ok" && (
                      <span className="inline-flex items-center gap-1 text-xs text-success">
                        <CheckCircle2 className="h-4 w-4" /> Analysé
                      </span>
                    )}
                    {f.statut === "parsing" && (
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <Loader2 className="h-4 w-4 animate-spin" /> Parsing…
                      </span>
                    )}
                    {f.statut === "erreur" && (
                      <span className="inline-flex items-center gap-1 text-xs text-destructive">
                        <AlertCircle className="h-4 w-4" /> Erreur
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => remove(f.nom)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Retirer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          {/* Action */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {tousParses
                ? "Tous les fichiers sont analysés — vous pouvez lancer l'analyse complète."
                : "L'analyse sera disponible une fois tous les fichiers parsés."}
            </p>
            {tousParses ? (
              <Link href={`/dossiers/${ROUEN.id}`}>
                <Button>
                  <Sparkles className="h-4 w-4" /> Lancer l'analyse
                </Button>
              </Link>
            ) : (
              <Button disabled>
                <Sparkles className="h-4 w-4" /> Lancer l'analyse
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
