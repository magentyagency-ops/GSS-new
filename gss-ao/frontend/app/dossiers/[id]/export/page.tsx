"use client";

import { CheckCircle2, AlertTriangle, FileType2, FileDown, Send } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { ROUEN, MEMOIRE_SECTIONS, formatDate } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const CHECKS = [
  { label: "Toutes les pièces administratives présentes", ok: false },
  { label: "Mémoire technique validé (4/4 sections)", ok: false },
  { label: "BPU / DPGF joints et complétés", ok: true },
  { label: "Acte d'Engagement signé électroniquement", ok: true },
  { label: "Certificat de visite joint", ok: true },
];

export default function ExportPage() {
  const pret = CHECKS.every((c) => c.ok);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {ROUEN.acheteur} · {ROUEN.reference}
          </div>
          <h1 className="text-xl font-semibold">Export & dépôt</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline">
            <FileType2 className="h-4 w-4" /> Exporter DOCX
          </Button>
          <Button variant="outline">
            <FileDown className="h-4 w-4" /> Exporter PDF
          </Button>
        </div>
      </header>

      <DossierNav id={ROUEN.id} />

      <div className="grid flex-1 grid-cols-[1fr_320px] gap-6 overflow-hidden p-6">
        {/* Prévisualisation PDF */}
        <div className="overflow-y-auto rounded-lg bg-muted/40 p-6">
          <div className="mx-auto max-w-[720px] space-y-4">
            <div className="rounded-md bg-card p-10 shadow-sm ring-1 ring-border">
              <div className="mb-8 border-b border-border pb-6 text-center">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  Mémoire technique — cadre de réponse
                </div>
                <h2 className="mt-2 text-2xl font-bold">{ROUEN.objet}</h2>
                <div className="mt-2 text-sm text-muted-foreground">
                  {ROUEN.acheteur} · {ROUEN.reference} · Remise le {formatDate(ROUEN.dateLimite)}
                </div>
                <div className="mt-4 text-sm font-medium">
                  Candidat : GSS — Sécurité privée
                </div>
              </div>

              {MEMOIRE_SECTIONS.map((s) => (
                <div key={s.id} className="mb-7">
                  <h3 className="mb-2 text-base font-semibold">
                    {s.num}. {s.titre}
                    <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
                      ({s.points} pts)
                    </span>
                  </h3>
                  {s.contenu.split("\n\n").map((par, i) => (
                    <p key={i} className="mb-2 text-[13px] leading-6 text-foreground/90">
                      {par}
                    </p>
                  ))}
                </div>
              ))}

              <div className="mt-10 border-t border-border pt-4 text-right text-xs text-muted-foreground">
                Fait à Rouen, le {formatDate(ROUEN.dateLimite)} — Signature & cachet
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar : check-list finale */}
        <aside className="space-y-4 overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Vérifications avant envoi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {CHECKS.map((c) => (
                <div
                  key={c.label}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                    c.ok ? "border-border" : "border-warning/40 bg-warning/5",
                  )}
                >
                  {c.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  )}
                  <span>{c.label}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {!pret && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-muted-foreground">
              Certaines vérifications ne sont pas satisfaites. Complétez la check-list de conformité
              et la validation du mémoire avant de marquer le dossier prêt.
            </div>
          )}

          <Separator />

          <Button className="w-full" disabled={!pret}>
            <Send className="h-4 w-4" /> Marquer comme prêt à envoyer
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Le dépôt s'effectue sur {ROUEN.plateforme} (hors application).
          </p>
        </aside>
      </div>
    </div>
  );
}
