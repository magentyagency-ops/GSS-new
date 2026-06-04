"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileCheck2, FileText, ArrowRight, AlertTriangle } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { getMode, setMode, type ResponseMode } from "@/lib/ai/mode";

/**
 * Écran 3 — Mode de réponse.
 * Détection auto (cadre imposé si un "Mémoire technique cadre de réponse" est
 * présent dans le DCE — vrai pour le cas Univ Rouen) + toggle manuel de
 * simulation Mode B pour la démo.
 */
export function ModeSelector({ id, templateDetected }: { id: string; templateDetected: boolean }) {
  const [mode, setLocalMode] = useState<ResponseMode>("A");

  useEffect(() => {
    setLocalMode(getMode(id));
  }, [id]);

  function change(m: ResponseMode) {
    setMode(id, m);
    setLocalMode(m);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Mode de réponse</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          {mode === "A" ? (
            <Badge variant="default" className="gap-1">
              <FileCheck2 className="h-3 w-3" /> Cadre imposé
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <FileText className="h-3 w-3" /> Réponse libre
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {templateDetected
              ? "Template « cadre de réponse » détecté dans le DCE."
              : "Aucun template client détecté."}
          </span>
        </div>

        {/* Toggle démo */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => change(mode === "A" ? "B" : "A")}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              mode === "B" ? "bg-warning" : "bg-secondary"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                mode === "B" ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
          <span className="text-sm">Simuler réponse libre</span>
        </div>

        {mode === "B" && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Mode démo — à utiliser uniquement pour démontrer le flux Mode B (réponse libre sur
            slides GSS).
          </div>
        )}

        {mode === "B" && (
          <Link href={`/dossiers/${id}/selection-slides`}>
            <Button size="sm" className="w-full">
              Analyser & sélectionner les slides <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
