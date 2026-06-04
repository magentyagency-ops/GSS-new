"use client";

import { useState } from "react";
import { FileType2, FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { ROUEN, IDENTITE_CANDIDAT, formatDate } from "@/lib/mock-data";
import { exportDocx } from "@/lib/ai/client";
import { getMode, memoireBKey, getAnalyzedSlides, getSelectedIndexes } from "@/lib/ai/mode";

/**
 * Boutons d'export de l'écran 6.
 * DOCX : le backend remplit le template selon le MODE du dossier —
 *   Mode A : template imposé Univ Rouen (zones rédigées par l'IA) ;
 *   Mode B : mémoire GSS (structure AO RNE Clarence) + slides sélectionnées.
 * PDF : désactivé (passer par Word/LibreOffice depuis le DOCX).
 */
export function ExportButtons() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function readSections(key: string): Record<string, string> {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const map = JSON.parse(raw) as Record<string, { text: string }>;
      return Object.fromEntries(
        Object.entries(map)
          .filter(([, v]) => v?.text?.trim())
          .map(([k, v]) => [k, v.text]),
      );
    } catch {
      return {};
    }
  }

  async function handleDocx() {
    if (busy) return;
    setError(null);
    const mode = getMode(ROUEN.id);
    const key = mode === "B" ? memoireBKey(ROUEN.id) : `gss_memoire_${ROUEN.id}`;
    const sections = readSections(key);
    if (Object.keys(sections).length === 0) {
      setError("Aucune section générée — rendez-vous sur l'écran Mémoire technique d'abord.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "B") {
        const sel = new Set(getSelectedIndexes(ROUEN.id));
        const selectedSlides = getAnalyzedSlides(ROUEN.id)
          .filter((s) => sel.has(s.index))
          .map((s) => ({
            index: s.index,
            file_name: s.file_name,
            category: s.category,
            chapter: s.chapter,
          }));
        await exportDocx({
          sections,
          mode: "B",
          selectedSlides,
          projet: ROUEN.objet,
          acheteur: ROUEN.acheteur,
          signataire: "Mme Vaché, Responsable réponse AO",
          dateSignature: formatDate(ROUEN.dateLimite),
          filename: "Memoire_Technique_GSS_reponse_libre.docx",
        });
      } else {
        await exportDocx({
          sections,
          mode: "A",
          identite: {
            denomination: IDENTITE_CANDIDAT.denomination,
            num_cnaps: IDENTITE_CANDIDAT.num_cnaps,
            date_autorisation: IDENTITE_CANDIDAT.date_autorisation,
          },
          signataire: "Mme Vaché, Responsable réponse AO",
          dateSignature: formatDate(ROUEN.dateLimite),
          filename: "Memoire_Technique_GSS_Univ_Rouen_MP2026-08.docx",
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export DOCX échoué");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={handleDocx} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileType2 className="h-4 w-4" />}
          Exporter DOCX
        </Button>
        <span title="Export DOCX puis Word/LibreOffice pour PDF.">
          <Button variant="outline" disabled>
            <FileDown className="h-4 w-4" /> Exporter PDF
          </Button>
        </span>
      </div>
      {error && <span className="max-w-xs text-right text-xs text-destructive">{error}</span>}
    </div>
  );
}
