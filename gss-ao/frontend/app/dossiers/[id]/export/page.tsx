"use client";

import { CheckCircle2, AlertTriangle, Send } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import { ExportButtons } from "@/components/export/export-buttons";
import {
  BlocContact,
  GroupeCases,
  Reponse,
  SectionTitre,
  SousQuestion,
} from "@/components/export/template-parts";
import {
  ROUEN,
  IDENTITE_CANDIDAT,
  SECTION_I,
  SECTION_II,
  SECTION_III,
  SECTION_IV,
  DELAIS_INTERVENTION,
  NB_INTERVENANTS_WE_JF,
  formatDate,
} from "@/lib/mock-data";
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
      {/* En-tête + boutons export — CONSERVÉS */}
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {ROUEN.acheteur} · {ROUEN.reference}
          </div>
          <h1 className="text-xl font-semibold">Export & dépôt</h1>
        </div>
        <ExportButtons />
      </header>

      <DossierNav id={ROUEN.id} />

      <div className="grid flex-1 grid-cols-[1fr_320px] gap-6 overflow-hidden p-6">
        {/* ============ Document central : template imposé ============ */}
        <div className="overflow-y-auto rounded-lg bg-muted/40 p-6">
          <div className="mx-auto max-w-3xl rounded-md border border-slate-200 bg-white p-12 shadow-sm">
            {/* En-tête du document */}
            <div className="mb-8 border-b border-slate-200 pb-6 text-center">
              <div className="text-xs uppercase tracking-widest text-slate-500">
                Mémoire technique — cadre de réponse
              </div>
              <h2 className="mt-2 text-2xl font-bold text-slate-900">{ROUEN.objet}</h2>
              <div className="mt-2 text-sm text-slate-500">
                {ROUEN.acheteur} · {ROUEN.reference} · Remise le {formatDate(ROUEN.dateLimite)}
              </div>
              <div className="mt-4 text-sm font-medium text-slate-700">
                Candidat : GSS — Sécurité privée
              </div>
            </div>

            {/* Bloc identité du candidat */}
            <div className="mb-8 rounded-md border border-slate-200 p-4">
              <div className="grid gap-1 text-sm">
                <div className="flex gap-2">
                  <span className="text-slate-500">Dénomination du candidat :</span>
                  <span className="font-medium text-slate-800">
                    {IDENTITE_CANDIDAT.denomination}
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="text-slate-500">N° CNAPS d'autorisation d'exercer :</span>
                  <span className="font-medium text-slate-800">{IDENTITE_CANDIDAT.num_cnaps}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-slate-500">Date d'obtention de l'autorisation :</span>
                  <span className="font-medium text-slate-800">
                    {IDENTITE_CANDIDAT.date_autorisation}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-8">
              {/* ---------- Section I ---------- */}
              <section className="space-y-4">
                <SectionTitre>
                  {SECTION_I.num}. {SECTION_I.titre} ({SECTION_I.points} pts)
                </SectionTitre>

                {SECTION_I.sousQuestions.map((q) => (
                  <div key={q.n} className="space-y-1.5">
                    <SousQuestion numero={q.n}>{q.label}</SousQuestion>
                    <Reponse>{q.reponse}</Reponse>
                  </div>
                ))}

                {/* 3. Sous-traitance — cases à cocher */}
                <div className="space-y-2">
                  <SousQuestion numero={3}>{SECTION_I.soustraitance.label}</SousQuestion>
                  <GroupeCases options={SECTION_I.soustraitance.options} />
                </div>

                {/* 4. Dispositif absence */}
                <div className="space-y-1.5">
                  <SousQuestion numero={4}>{SECTION_I.dispositifAbsence.label}</SousQuestion>
                  <Reponse>{SECTION_I.dispositifAbsence.reponse}</Reponse>
                </div>

                {/* 5 & 6. Interlocuteurs */}
                <div className="space-y-1.5">
                  <SousQuestion numero={5}>{SECTION_I.interlocuteurPrincipal.label}</SousQuestion>
                  <BlocContact contact={SECTION_I.interlocuteurPrincipal.contact} />
                </div>
                <div className="space-y-1.5">
                  <SousQuestion numero={6}>{SECTION_I.interlocuteurDevis.label}</SousQuestion>
                  <BlocContact contact={SECTION_I.interlocuteurDevis.contact} />
                </div>
              </section>

              {/* ---------- Section II ---------- */}
              <section className="space-y-4">
                <SectionTitre>
                  {SECTION_II.num}. {SECTION_II.titre} ({SECTION_II.points} pts)
                </SectionTitre>
                <Reponse>{SECTION_II.reponse}</Reponse>
              </section>

              {/* ---------- Section III ---------- */}
              <section className="space-y-4">
                <SectionTitre>
                  {SECTION_III.num}. {SECTION_III.titre}
                </SectionTitre>
                {SECTION_III.blocs.map((b) => (
                  <div key={b.titre} className="space-y-1.5 rounded-md border border-slate-200 p-3">
                    <div className="text-sm font-semibold text-slate-800">
                      {b.titre} <span className="font-normal text-slate-500">({b.points} pts)</span>
                    </div>
                    <Reponse>{b.reponse}</Reponse>
                  </div>
                ))}
              </section>

              {/* ---------- Section IV ---------- */}
              <section className="space-y-4">
                <SectionTitre>
                  {SECTION_IV.num}. {SECTION_IV.titre} ({SECTION_IV.points} pts — lot 3 uniquement)
                </SectionTitre>

                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {SECTION_IV.lotNote}
                </div>

                {/* 1. APSAD */}
                <div className="space-y-2">
                  <SousQuestion numero={1}>{SECTION_IV.apsad.label}</SousQuestion>
                  <GroupeCases options={SECTION_IV.apsad.options} />
                </div>

                {/* 2. Localisation */}
                <div className="space-y-1.5">
                  <SousQuestion numero={2}>{SECTION_IV.localisation.label}</SousQuestion>
                  <Reponse>{SECTION_IV.localisation.reponse}</Reponse>
                </div>

                {/* 3. Sous-traitance lever de doute */}
                <div className="space-y-1.5">
                  <SousQuestion numero={3}>{SECTION_IV.soustraitanceLeverDoute.label}</SousQuestion>
                  <ul className="ml-1 space-y-1">
                    {SECTION_IV.soustraitanceLeverDoute.departements.map((d) => (
                      <li key={d.dep} className="text-sm text-slate-700">
                        <span className="font-medium">Département {d.dep} :</span> {d.valeur}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 4. Report alarmes */}
                <div className="space-y-1.5">
                  <SousQuestion numero={4}>{SECTION_IV.reportAlarmes.label}</SousQuestion>
                  <Reponse>{SECTION_IV.reportAlarmes.reponse}</Reponse>
                </div>

                {/* 5. Moyens d'ouverture */}
                <div className="space-y-1.5">
                  <SousQuestion numero={5}>{SECTION_IV.moyensOuverture.label}</SousQuestion>
                  <Reponse>{SECTION_IV.moyensOuverture.reponse}</Reponse>
                </div>

                {/* 6. Délais — tableau */}
                <div className="space-y-2">
                  <SousQuestion numero={6}>{SECTION_IV.delaisLabel}</SousQuestion>
                  <div className="rounded-md border border-slate-200">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Site</TableHead>
                          <TableHead className="text-right">Délai max. d'intervention</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {DELAIS_INTERVENTION.map((d) => (
                          <TableRow key={d.site}>
                            <TableCell className="text-slate-700">{d.site}</TableCell>
                            <TableCell className="text-right font-medium tabular-nums text-slate-800">
                              {d.delai_minutes} min
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* 7. Nombre d'intervenants */}
                <div className="space-y-1.5">
                  <SousQuestion numero={7}>{SECTION_IV.intervenantsLabel}</SousQuestion>
                  <div className="inline-flex items-baseline gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-2">
                    <span className="text-2xl font-bold text-indigo-700">
                      {NB_INTERVENANTS_WE_JF}
                    </span>
                    <span className="text-sm text-slate-500">intervenants véhiculés</span>
                  </div>
                </div>
              </section>
            </div>

            {/* Signature */}
            <div className="mt-10 border-t border-slate-200 pt-6 text-right text-sm leading-6 text-slate-700">
              <div>Fait à Rouen, le {formatDate(ROUEN.dateLimite)}</div>
              <div className="font-medium text-slate-900">GSS — Sécurité privée</div>
              <div>Mme Vaché, Responsable réponse AO</div>
              <div className="italic text-slate-400">[Signature électronique]</div>
            </div>
          </div>
        </div>

        {/* ============ Sidebar : vérifications — CONSERVÉE ============ */}
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
