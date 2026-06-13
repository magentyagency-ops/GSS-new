"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import {
  CalendarClock,
  MapPin,
  Building2,
  FileText,
  Mail,
  Star,
  UserPlus,
  AlertTriangle,
  ArrowRight,
  Scale,
  ShieldAlert,
  Clock,
  Banknote,
  Sparkles,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Separator,
} from "@/components/ui";
import { DossierNav } from "@/components/dossier-nav";
import {
  formatDate,
  formatDateHeure,
  joursRestants,
} from "@/lib/gss-config";
import { cn } from "@/lib/utils";

function StatPill({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-md",
          accent ? "bg-destructive/10 text-destructive" : "bg-accent text-accent-foreground",
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="leading-tight">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold">{value}</div>
      </div>
    </div>
  );
}

function BaremeBar({ libelle, points, max, lots }: { libelle: string; points: number; max: number; lots: number[] }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          {libelle}
          {lots.length > 0 && (
            <Badge variant="outline" className="font-normal">
              Lots {lots.join(", ")}
            </Badge>
          )}
        </span>
        <span className="font-semibold tabular-nums">{points} pts</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(points / max) * 100}%` }} />
      </div>
    </div>
  );
}

export default function SynthesePage({ params }: { params: { id: string } }) {
  const id = params.id;

  const [dossierInfo, setDossierInfo] = useState<any>(null);

  useEffect(() => {
    fetch(`http://localhost:8000/api/dossiers/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) {
          setDossierInfo(data);
        }
      })
      .catch((e) => console.error(e));
  }, [id]);

  if (!dossierInfo) {
    return <div className="p-8 text-center">Chargement du dossier...</div>;
  }

  const jours = joursRestants(dossierInfo.dateLimite);
  const criteres = dossierInfo.criteres?.sous_criteres || [];
  const technique = criteres.filter((c: any) => c.axe !== "prix");
  const prix = criteres.filter((c: any) => c.axe === "prix");
  const SCORE_TECHNIQUE = dossierInfo.criteres?.valeur_technique_pts || 60;
  const SCORE_PRIX = dossierInfo.criteres?.prix_pts || 40;

  return (
    <div className="flex h-full flex-col">
      {/* En-tête identité */}
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="default">{dossierInfo.statut}</Badge>
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {dossierInfo.reference} · CCAG {dossierInfo.ccag} · CPV {dossierInfo.cpv}
              </span>
            </div>
            <h1 className="text-xl font-semibold">{dossierInfo.objet}</h1>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4" /> {dossierInfo.acheteur}
            </p>
          </div>
          <Link href={`/dossiers/${id}/conformite`}>
            <Button>
              Étape suivante <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-3 w-64 ml-auto">
          <StatPill icon={FileText} label="Procédure" value={dossierInfo.procedure} />
        </div>
      </header>

      <DossierNav id={id} />

      {/* Corps */}
      <div className="grid flex-1 grid-cols-[1fr_300px] gap-6 overflow-y-auto p-6">
        <div className="space-y-6">
          {/* Résumé Exécutif IA */}
          <Card className="border-primary/20 bg-primary/5 shadow-sm">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base text-primary">
                <Sparkles className="h-5 w-5" /> 
                Synthèse du projet (Générée par l'IA)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm leading-relaxed text-foreground/90 space-y-4">
                <div>
                  <strong className="text-primary">1. Objet et périmètre du marché</strong>
                  <p className="mt-1">
                    {dossierInfo.acheteur} lance une consultation (Appel d'Offres Ouvert) pour le renouvellement complet de ses prestations de sécurité, de sûreté et de gardiennage. Le marché couvre l'ensemble du patrimoine immobilier universitaire, divisé géographiquement : la Seine-Maritime pour le Lot 1 (campus principaux), l'Eure pour le Lot 2 (Évreux), et un Lot 3 transversal dédié exclusivement à la télésurveillance et aux levées de doute.
                  </p>
                </div>
                <div>
                  <strong className="text-primary">2. Volume et durée</strong>
                  <p className="mt-1">
                    Le marché est conclu pour une période initiale de 1 an, reconductible expressément 3 fois (durée maximale de 4 ans). Le démarrage des prestations est impérativement fixé au 5 juillet 2026, imposant une phase de transition et de reprise du personnel (Article L1224-1) extrêmement courte qu'il faudra détailler dans notre méthodologie.
                  </p>
                </div>
                <div>
                  <strong className="text-primary">3. Exigences opérationnelles majeures</strong>
                  <p className="mt-1">
                    Le CCTP impose une présence humaine continue (24h/24 et 7j/7) sur les sites majeurs, avec des profils qualifiés SSIAP 1 et SSIAP 2. Le niveau de posture Vigipirate exige des contrôles d'accès renforcés (inspection visuelle des sacs). L'utilisation d'outils de traçabilité électronique en temps réel (mains courantes informatisées, PTI/DATI) est un prérequis éliminatoire. Une clause d'insertion sociale impose 5% des heures travaillées à un public éloigné de l'emploi.
                  </p>
                </div>
                <div>
                  <strong className="text-primary">4. Stratégie de réponse (Analyse de la notation)</strong>
                  <p className="mt-1">
                    La valeur technique est le facteur clé de succès (60% de la note). L'acheteur est particulièrement exigeant sur la méthodologie de déploiement (Moyens humains et matériels évalués à 40 points). Le Mémoire Technique devra démontrer une capacité de mobilisation immédiate, inclure un Plan d'Assurance Qualité (PAQ) robuste, et prouver notre engagement RSE (ex: flotte de véhicules électriques pour les rondes).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Analyse des risques IA */}
          <Card className="border-destructive/30 bg-destructive/5 shadow-sm">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <AlertTriangle className="h-5 w-5" /> 
                Analyse des risques & Points d'attention
              </CardTitle>
              <Badge variant="destructive" className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-destructive/20">
                Aide au Go / No-Go
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-destructive/20 bg-background/50 px-4 py-3">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-destructive">
                    <Scale className="h-4 w-4" /> Pénalités atypiques
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Le CCAP (Art. 14.1) prévoit des pénalités de retard <strong className="text-foreground">déplafonnées</strong>. Très rare et risqué pour ce type de marché.
                  </p>
                </div>
                
                <div className="rounded-lg border border-amber-500/20 bg-background/50 px-4 py-3">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-amber-600 dark:text-amber-500">
                    <ShieldAlert className="h-4 w-4" /> Certifications sous-traitants
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Exigence stricte de la certification <strong className="text-foreground">ISO 27001</strong> pour les éventuels sous-traitants (Lot 3).
                  </p>
                </div>

                <div className="rounded-lg border border-amber-500/20 bg-background/50 px-4 py-3">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-amber-600 dark:text-amber-500">
                    <Clock className="h-4 w-4" /> Délais d'exécution serrés
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Délai de mise en place initial fixé à <strong className="text-foreground">15 jours</strong> après notification (très court vu les effectifs demandés).
                  </p>
                </div>

                <div className="rounded-lg border border-border bg-background/50 px-4 py-3">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-primary">
                    <Banknote className="h-4 w-4" /> Conditions financières
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Paiement à 30 jours (standard). Aucune avance n'est prévue au CCAP. Révision des prix annuelle.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Barème */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Barème de notation pondéré</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-primary">Valeur technique</span>
                  <Badge variant="default">{SCORE_TECHNIQUE} points</Badge>
                </div>
                <div className="space-y-3">
                  {technique.map((c: any) => (
                    <BaremeBar key={c.libelle} libelle={c.libelle} points={c.points} max={SCORE_TECHNIQUE} lots={c.lots || []} />
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">Prix</span>
                  <Badge variant="secondary">{SCORE_PRIX} points</Badge>
                </div>
                <div className="space-y-3">
                  {prix.map((c: any) => (
                    <BaremeBar key={c.libelle} libelle={c.libelle} points={c.points} max={SCORE_TECHNIQUE} lots={c.lots || []} />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar actions */}
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Informations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Responsable</div>
                <div className="font-medium">{dossierInfo.responsable}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Durée du marché</div>
                <div className="font-medium">{dossierInfo.duree}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Plateforme de remise</div>
                <div className="font-medium">{dossierInfo.plateforme}</div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
