"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  XCircle,
  MinusCircle,
  AlertTriangle,
  FileSearch,
  X,
  ArrowRight,
} from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { ROUEN, PIECES_CANDIDATURE, PIECES_OFFRE, type Piece } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

type Etat = Piece["etat"];
const ETATS: { key: Etat; label: string; icon: React.ElementType; cls: string }[] = [
  { key: "obtenu", label: "Obtenu", icon: CheckCircle2, cls: "text-success" },
  { key: "attente", label: "En attente", icon: Clock, cls: "text-warning" },
  { key: "manquant", label: "Manquant", icon: XCircle, cls: "text-destructive" },
  { key: "na", label: "N/A", icon: MinusCircle, cls: "text-muted-foreground" },
];

function PieceRow({
  piece,
  onCycle,
  onRef,
}: {
  piece: Piece;
  onCycle: () => void;
  onRef: () => void;
}) {
  const meta = ETATS.find((e) => e.key === piece.etat)!;
  const Icon = meta.icon;
  const bloquant = piece.etat === "manquant" && piece.obligatoire;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2.5",
        bloquant ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}
    >
      <button onClick={onCycle} title="Changer l'état">
        <Icon className={cn("h-5 w-5", meta.cls)} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{piece.nom}</span>
          {piece.alternative && (
            <Badge variant="outline" className="font-normal">
              ou {piece.alternative}
            </Badge>
          )}
          {!piece.obligatoire && (
            <Badge variant="secondary" className="font-normal">
              facultatif
            </Badge>
          )}
        </div>
        <button
          onClick={onRef}
          className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
        >
          <FileSearch className="h-3 w-3" /> Voir la référence dans le RC ({piece.ref})
        </button>
      </div>
      <Badge variant={meta.key === "obtenu" ? "success" : meta.key === "manquant" ? "destructive" : meta.key === "attente" ? "warning" : "secondary"}>
        {meta.label}
      </Badge>
    </div>
  );
}

export default function ConformitePage() {
  const [cand, setCand] = useState(PIECES_CANDIDATURE);
  const [offre, setOffre] = useState(PIECES_OFFRE);
  const [refPiece, setRefPiece] = useState<Piece | null>(null);

  const cycle = (list: Piece[], setList: (p: Piece[]) => void, nom: string) => {
    setList(
      list.map((p) => {
        if (p.nom !== nom) return p;
        const idx = ETATS.findIndex((e) => e.key === p.etat);
        return { ...p, etat: ETATS[(idx + 1) % ETATS.length].key };
      }),
    );
  };

  const manquants = useMemo(
    () => [...cand, ...offre].filter((p) => p.obligatoire && p.etat === "manquant"),
    [cand, offre],
  );
  const total = cand.length + offre.length;
  const obtenus = [...cand, ...offre].filter((p) => p.etat === "obtenu").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {ROUEN.acheteur} · {ROUEN.reference}
          </div>
          <h1 className="text-xl font-semibold">Check-list de conformité administrative</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {obtenus}/{total} pièces obtenues
          </span>
          <Link href={`/dossiers/${ROUEN.id}/memoire`}>
            <Button>
              Étape suivante <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      <DossierNav id={ROUEN.id} />

      <div className="flex-1 overflow-y-auto p-6">
        {/* Alerte */}
        {manquants.length > 0 && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <div className="text-sm font-semibold text-destructive">
                {manquants.length} pièce(s) obligatoire(s) manquante(s) — offre éliminée si non
                fournie
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {manquants.map((p) => p.nom).join(" · ")}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Candidature
                <Badge variant="secondary">{cand.length} pièces</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {cand.map((p) => (
                <PieceRow
                  key={p.nom}
                  piece={p}
                  onCycle={() => cycle(cand, setCand, p.nom)}
                  onRef={() => setRefPiece(p)}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Offre
                <Badge variant="secondary">{offre.length} pièces</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {offre.map((p) => (
                <PieceRow
                  key={p.nom}
                  piece={p}
                  onCycle={() => cycle(offre, setOffre, p.nom)}
                  onRef={() => setRefPiece(p)}
                />
              ))}
            </CardContent>
          </Card>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Astuce : cliquez sur l'icône d'état à gauche d'une pièce pour la faire passer de Obtenu →
          En attente → Manquant → N/A.
        </p>
      </div>

      {/* Panneau latéral : référence RC */}
      {refPiece && (
        <div className="fixed inset-0 z-50 flex justify-end bg-foreground/20" onClick={() => setRefPiece(null)}>
          <div
            className="h-full w-[420px] overflow-y-auto border-l border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Référence dans le RC</h3>
              <button onClick={() => setRefPiece(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <Badge variant="outline" className="mb-3">
              {refPiece.ref}
            </Badge>
            <div className="text-sm font-medium">{refPiece.nom}</div>
            <div className="mt-3 rounded-md bg-muted/40 p-3 text-sm leading-6 text-muted-foreground">
              Extrait du Règlement de Consultation (2-RC 2026-08) : la pièce «&nbsp;{refPiece.nom}
              &nbsp;» figure parmi les éléments à produire ({refPiece.ref}). Document exigé
              {refPiece.obligatoire ? " à peine d'irrecevabilité." : " (facultatif)."}
              {refPiece.alternative && ` Alternative admise : ${refPiece.alternative}.`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
