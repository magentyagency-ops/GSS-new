"use client";

import { use, useEffect, useMemo, useState } from "react";
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
  UploadCloud,
  FileCheck,
} from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { type Piece, type DceFile } from "@/lib/gss-config";
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
  onUpload,
  onRef,
}: {
  piece: Piece;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRef: () => void;
}) {
  const meta = ETATS.find((e) => e.key === piece.etat)!;
  const Icon = meta.icon;
  const bloquant = piece.etat === "manquant" && piece.obligatoire;
  
  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-md border px-4 py-3",
        bloquant ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}
    >
      <div className="flex shrink-0 items-center justify-center">
        <Icon className={cn("h-5 w-5", meta.cls)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{piece.nom}</span>
          {piece.alternative && (
            <Badge variant="outline" className="font-normal text-xs">
              ou {piece.alternative}
            </Badge>
          )}
          {!piece.obligatoire && (
            <Badge variant="secondary" className="font-normal text-xs">
              facultatif
            </Badge>
          )}
        </div>
        <button
          onClick={onRef}
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <FileSearch className="h-3 w-3" /> Source RC ({piece.ref})
        </button>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <Badge variant={meta.key === "obtenu" ? "success" : meta.key === "manquant" ? "destructive" : meta.key === "attente" ? "warning" : "secondary"}>
          {meta.label}
        </Badge>
        
        {/* Upload Button */}
        <label className="cursor-pointer">
          <input type="file" className="hidden" onChange={onUpload} accept=".pdf,.doc,.docx,.zip" />
          <div className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors border",
            piece.etat === "obtenu" 
              ? "border-border bg-muted/50 text-muted-foreground hover:bg-muted" 
              : "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          )}>
            {piece.etat === "obtenu" ? (
              <><FileCheck className="h-3.5 w-3.5" /> Remplacer</>
            ) : (
              <><UploadCloud className="h-3.5 w-3.5" /> Uploader</>
            )}
          </div>
        </label>
      </div>
    </div>
  );
}

export default function ConformitePage({ params }: { params: { id: string } }) {
  const id = params.id;

  const [dossierInfo, setDossierInfo] = useState<any>({ acheteur: "Chargement...", reference: "..." });
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [refPiece, setRefPiece] = useState<Piece | null>(null);
  const storageKey = `gss_conformite_v4_${id}`;

  useEffect(() => {
    fetch(`http://localhost:8000/api/dossiers/${id}`)
      .then(res => res.json())
      .then(data => {
        if (!data.error) setDossierInfo(data);
      })
      .catch(e => console.error(e));
    
    // Charger d'abord dce_files (les fichiers déposés) pour créer les pièces de base
    const uploadedFilesRaw = localStorage.getItem(`dce_files_${id}`);
    let basePieces: Piece[] = [];
    
    if (uploadedFilesRaw) {
      try {
        const uploadedFiles: DceFile[] = JSON.parse(uploadedFilesRaw);
        basePieces = uploadedFiles.map(f => ({
          nom: f.nom,
          obligatoire: ["RC", "CCTP", "CCAP", "BPU / DPGF"].includes(f.type),
          alternative: null,
          etat: "obtenu" as Etat,
          ref: f.type
        }));
      } catch (e) {
        console.error("Failed to parse uploaded files");
      }
    } else {
      // Fallback
      basePieces = [
        { nom: "CCTP / CCP (Exigences techniques)", obligatoire: true, alternative: null, etat: "obtenu" as Etat, ref: "Prérequis DCE" },
        { nom: "Règlement de Consultation (RC)", obligatoire: true, alternative: null, etat: "obtenu" as Etat, ref: "Prérequis DCE" },
        { nom: "Cahier des Clauses Administratives Particulières (CCAP)", obligatoire: true, alternative: null, etat: "obtenu" as Etat, ref: "Prérequis DCE" },
        { nom: "BPU / DPGF (Chiffrage)", obligatoire: true, alternative: null, etat: "obtenu" as Etat, ref: "Prérequis DCE" },
        { nom: "Template Mémoire Client (.docx)", obligatoire: true, alternative: null, etat: "obtenu" as Etat, ref: "Prérequis DCE" },
      ];
    }

    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (data.pieces) {
          setPieces(data.pieces);
          return;
        }
      } catch (e) {
        console.error("Failed to parse conformite data");
      }
    }
    
    setPieces(basePieces);
  }, [id, storageKey]);


  const persist = (newPieces: Piece[]) => {
    setPieces(newPieces);
    localStorage.setItem(storageKey, JSON.stringify({ pieces: newPieces }));
  };

  const handleUpload = (nom: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return; // if user cancelled

    const newPieces = pieces.map(p => p.nom === nom ? { ...p, etat: "obtenu" as Etat } : p);
    persist(newPieces);
    
    // Clear the input so the same file can be uploaded again if needed
    e.target.value = "";
  };

  const manquants = useMemo(
    () => pieces.filter((p) => p.obligatoire && p.etat === "manquant"),
    [pieces],
  );
  const total = pieces.length;
  const obtenus = pieces.filter((p) => p.etat === "obtenu").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {dossierInfo.acheteur} · {dossierInfo.reference}
          </div>
          <h1 className="text-xl font-semibold">Check-list de conformité administrative</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {obtenus}/{total} pièces obtenues
          </span>
          <Link href={`/dossiers/${id}/memoire`}>
            <Button>
              Étape suivante <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      <DossierNav id={id} />

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

        <div className="grid grid-cols-1 gap-6 max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Pièces Requises
                <Badge variant="secondary">{pieces.length} pièces</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {pieces.map((p) => (
                <PieceRow
                  key={p.nom}
                  piece={p}
                  onUpload={(e) => handleUpload(p.nom, e)}
                  onRef={() => setRefPiece(p)}
                />
              ))}
            </CardContent>
          </Card>
        </div>
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
              Extrait du Règlement de Consultation (RC) : la pièce «&nbsp;{refPiece.nom}
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
