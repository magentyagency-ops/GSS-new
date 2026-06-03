"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search, Clock, AlertTriangle } from "lucide-react";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import {
  DOSSIERS,
  STATUT_VARIANT,
  type Statut,
  formatDate,
  joursRestants,
} from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const STATUTS: (Statut | "Tous")[] = ["Tous", "Brouillon", "En cours", "À valider", "Envoyé"];

export default function DossiersPage() {
  const [filtre, setFiltre] = useState<Statut | "Tous">("Tous");
  const [recherche, setRecherche] = useState("");

  const lignes = useMemo(() => {
    return DOSSIERS.filter((d) => filtre === "Tous" || d.statut === filtre)
      .filter((d) => d.acheteur.toLowerCase().includes(recherche.toLowerCase()))
      .sort((a, b) => +new Date(a.dateLimite) - +new Date(b.dateLimite));
  }, [filtre, recherche]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Dossiers d'appels d'offres</h1>
          <p className="text-sm text-muted-foreground">
            {DOSSIERS.length} dossiers · {DOSSIERS.filter((d) => d.statut === "En cours").length} en
            cours de traitement
          </p>
        </div>
        <Link href="/dossiers/nouveau">
          <Button>
            <Plus className="h-4 w-4" /> Nouveau dossier
          </Button>
        </Link>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {/* Filtres */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            {STATUTS.map((s) => (
              <button
                key={s}
                onClick={() => setFiltre(s)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  filtre === s
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
              placeholder="Rechercher un acheteur…"
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        {/* Tableau */}
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Acheteur</TableHead>
                <TableHead>Objet</TableHead>
                <TableHead>Lots</TableHead>
                <TableHead>Date limite</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Responsable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lignes.map((d) => {
                const jours = joursRestants(d.dateLimite);
                const urgent = jours <= 14 && d.statut !== "Envoyé";
                return (
                  <TableRow key={d.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link href={`/dossiers/${d.id}`} className="hover:text-primary">
                        {d.acheteur}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-muted-foreground">
                      {d.objet}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {d.lots.map((l) => (
                          <Badge key={l} variant="outline" className="font-normal">
                            {l}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{formatDate(d.dateLimite)}</span>
                        {d.statut !== "Envoyé" && (
                          <span
                            className={cn(
                              "flex items-center gap-1 text-xs",
                              urgent ? "text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {urgent ? (
                              <AlertTriangle className="h-3 w-3" />
                            ) : (
                              <Clock className="h-3 w-3" />
                            )}
                            J−{jours}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUT_VARIANT[d.statut]}>{d.statut}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.responsable}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
