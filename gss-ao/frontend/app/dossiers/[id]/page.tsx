import Link from "next/link";
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
import { ModeSelector } from "@/components/ai/mode-selector";
import {
  ROUEN,
  CRITERES,
  SCORE_TECHNIQUE,
  SCORE_PRIX,
  formatDate,
  formatDateHeure,
  joursRestants,
} from "@/lib/mock-data";
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

export default function SynthesePage() {
  const jours = joursRestants(ROUEN.dateLimite);
  const technique = CRITERES.filter((c) => c.axe === "technique");
  const prix = CRITERES.filter((c) => c.axe === "prix");

  return (
    <div className="flex h-full flex-col">
      {/* En-tête identité */}
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="default">{ROUEN.statut}</Badge>
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {ROUEN.reference} · CCAG {ROUEN.ccag} · CPV {ROUEN.cpv}
              </span>
            </div>
            <h1 className="text-xl font-semibold">{ROUEN.objet}</h1>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4" /> {ROUEN.acheteur}
            </p>
          </div>
          <Link href={`/dossiers/${ROUEN.id}/conformite`}>
            <Button>
              Étape suivante <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatPill
            icon={CalendarClock}
            label="Date limite de remise"
            value={`${formatDate(ROUEN.dateLimite)} · J−${jours}`}
            accent={jours <= 30}
          />
          <StatPill icon={MapPin} label="Visite obligatoire" value={formatDate(ROUEN.dateVisite)} />
          <StatPill icon={FileText} label="Procédure" value={ROUEN.procedure} />
        </div>
      </header>

      <DossierNav id={ROUEN.id} />

      {/* Corps */}
      <div className="grid flex-1 grid-cols-[1fr_300px] gap-6 overflow-y-auto p-6">
        <div className="space-y-6">
          {/* Visite */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <MapPin className="h-4 w-4 text-primary" /> Visite de site
              </CardTitle>
              {ROUEN.visiteObligatoire && <Badge variant="warning">Obligatoire</Badge>}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  Un certificat de visite est exigé et doit être joint à l'offre — l'absence de
                  visite rend la candidature irrecevable.
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Date & heure</div>
                  <div className="font-medium">{formatDateHeure(ROUEN.dateVisite)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Lieu</div>
                  <div className="font-medium">{ROUEN.lieuVisite}</div>
                </div>
              </div>
              <Button variant="outline" size="sm">
                <CalendarClock className="h-4 w-4" /> Planifier la visite
              </Button>
            </CardContent>
          </Card>

          {/* Lots */}
          <div>
            <h2 className="mb-2 text-sm font-semibold">Allotissement</h2>
            <div className="grid grid-cols-3 gap-3">
              {ROUEN.lots.map((lot) => (
                <Card key={lot.numero}>
                  <CardContent className="p-4">
                    <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                      {lot.numero}
                    </div>
                    <div className="text-sm font-medium">{lot.intitule}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{lot.perimetre}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

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
                  {technique.map((c) => (
                    <BaremeBar key={c.libelle} libelle={c.libelle} points={c.points} max={SCORE_TECHNIQUE} lots={c.lots} />
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
                  {prix.map((c) => (
                    <BaremeBar key={c.libelle} libelle={c.libelle} points={c.points} max={SCORE_TECHNIQUE} lots={c.lots} />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar actions */}
        <aside className="space-y-4">
          <ModeSelector id={ROUEN.id} templateDetected={true} />
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Actions rapides</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" size="sm" className="w-full justify-start">
                <Mail className="h-4 w-4" /> Envoyer le mail récap
              </Button>
              <Button variant="outline" size="sm" className="w-full justify-start">
                <Star className="h-4 w-4" /> Marquer prioritaire
              </Button>
              <Button variant="outline" size="sm" className="w-full justify-start">
                <UserPlus className="h-4 w-4" /> Affecter un responsable
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Informations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Responsable</div>
                <div className="font-medium">{ROUEN.responsable}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Durée du marché</div>
                <div className="font-medium">{ROUEN.duree}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Plateforme de remise</div>
                <div className="font-medium">{ROUEN.plateforme}</div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
