"use client";

import { useState } from "react";
import { FileType2, FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { EXPORT_FILENAME, triggerDownload } from "@/lib/export/document-model";

/**
 * Boutons d'export DOCX / PDF de l'écran 6.
 * Génération 100 % client. Les générateurs sont chargés en import dynamique
 * (hors du bundle initial) au moment du clic.
 */
export function ExportButtons() {
  const [busy, setBusy] = useState<"docx" | "pdf" | null>(null);

  async function handleDocx() {
    if (busy) return;
    setBusy("docx");
    try {
      const { generateDocxBlob } = await import("@/lib/export/docx-export");
      const blob = await generateDocxBlob();
      triggerDownload(blob, `${EXPORT_FILENAME}.docx`);
    } catch (e) {
      console.error("Export DOCX échoué :", e);
    } finally {
      setBusy(null);
    }
  }

  async function handlePdf() {
    if (busy) return;
    setBusy("pdf");
    try {
      const { generatePdfBlob } = await import("@/lib/export/pdf-export");
      const blob = await generatePdfBlob();
      triggerDownload(blob, `${EXPORT_FILENAME}.pdf`);
    } catch (e) {
      console.error("Export PDF échoué :", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={handleDocx} disabled={busy !== null}>
        {busy === "docx" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FileType2 className="h-4 w-4" />
        )}
        Exporter DOCX
      </Button>
      <Button variant="outline" onClick={handlePdf} disabled={busy !== null}>
        {busy === "pdf" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FileDown className="h-4 w-4" />
        )}
        Exporter PDF
      </Button>
    </div>
  );
}
