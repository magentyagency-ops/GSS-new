"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search, Clock, AlertTriangle, Trash2, X } from "lucide-react";
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
  STATUT_VARIANT,
  type Statut,
  type DossierRow,
  formatDate,
  joursRestants,
} from "@/lib/gss-config";
import { cn } from "@/lib/utils";

const STATUTS: (Statut | "Tous")[] = ["Tous", "Brouillon", "En cours", "À valider", "Envoyé"];

export default function DossiersPage() {
  const [filtre, setFiltre] = useState<Statut | "Tous">("Tous");
  const [recherche, setRecherche] = useState("");
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);
  const [supprimerDossier, setSupprimerDossier] = useState<DossierRow | null>(null);

  useEffect(() => {
    fetch("http://localhost:8000/api/dossiers")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setDossiers(data);
      })
      .catch((e) => console.error(e));
  }, []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [supprimerMultiple, setSupprimerMultiple] = useState(false);

  const lignes = useMemo(() => {
    return dossiers
      .filter((d) => filtre === "Tous" || d.statut === filtre)
      .filter((d) => (d.acheteur || "").toLowerCase().includes(recherche.toLowerCase()) || (d.objet || "").toLowerCase().includes(recherche.toLowerCase()))
      .sort((a, b) => +new Date(a.dateLimite || 0) - +new Date(b.dateLimite || 0));
  }, [filtre, recherche, dossiers]);

  const handleSupprimer = useCallback(() => {
    if (!supprimerDossier) return;
    setDossiers((prev) => prev.filter((d) => d.id !== supprimerDossier.id));
    fetch(`http://localhost:8000/api/dossiers/${supprimerDossier.id}`, {
      method: "DELETE",
    }).catch((e) => console.error(e));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(supprimerDossier.id);
      return next;
    });
    setSupprimerDossier(null);
  }, [supprimerDossier]);

  const handleSupprimerMultiple = useCallback(() => {
    setDossiers((prev) => prev.filter((d) => !selectedIds.has(d.id)));
    
    // Call delete API for each selected
    Array.from(selectedIds).forEach((id) => {
      fetch(`http://localhost:8000/api/dossiers/${id}`, {
        method: "DELETE",
      }).catch((e) => console.error(e));
    });
    setSelectedIds(new Set());
    setSupprimerMultiple(false);
  }, [selectedIds]);

  const allSelected = lignes.length > 0 && lignes.every((d) => selectedIds.has(d.id));
  const someSelected = lignes.some((d) => selectedIds.has(d.id)) && !allSelected;

  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        lignes.forEach((d) => next.delete(d.id));
      } else {
        lignes.forEach((d) => next.add(d.id));
      }
      return next;
    });
  }, [allSelected, lignes]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Dossiers d'appels d'offres</h1>
          <p className="text-sm text-muted-foreground">
            {dossiers.length} dossiers · {dossiers.filter((d) => d.statut === "En cours").length} en
            cours de traitement
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedIds.size > 0 && (
            <Button
              variant="destructive"
              onClick={() => setSupprimerMultiple(true)}
              className="bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">Supprimer ({selectedIds.size})</span>
            </Button>
          )}
          <Link href="/dossiers/nouveau">
            <Button>
              <Plus className="h-4 w-4" /> Nouveau dossier
            </Button>
          </Link>
        </div>
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
                <TableHead className="w-[40px]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input bg-background text-primary accent-primary"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={handleSelectAll}
                  />
                </TableHead>
                <TableHead>Acheteur</TableHead>
                <TableHead>Objet</TableHead>
                <TableHead>Lots</TableHead>
                <TableHead>Date limite</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Responsable</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lignes.map((d) => {
                const jours = joursRestants(d.dateLimite);
                const urgent = jours <= 14 && d.statut !== "Envoyé";
                const isSelected = selectedIds.has(d.id);
                return (
                  <TableRow
                    key={d.id}
                    className={cn(
                      "group cursor-pointer",
                      isSelected && "bg-muted/50"
                    )}
                    onClick={() => window.location.href = `/dossiers/${d.id}`}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input bg-background text-primary accent-primary"
                        checked={isSelected}
                        onChange={() => {
                          const next = new Set(selectedIds);
                          if (next.has(d.id)) next.delete(d.id);
                          else next.add(d.id);
                          setSelectedIds(next);
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {d.acheteur || d.objet || "Dossier en cours de traitement…"}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-muted-foreground">
                      {d.objet || "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {d.lots?.map((l: any, i: number) => (
                          <Badge key={i} variant="outline" className="font-normal">
                            {l?.intitule || l}
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
                    <TableCell>
                      <button
                        id={`delete-dossier-${d.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSupprimerDossier(d);
                        }}
                        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        title="Supprimer le dossier"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Modale de confirmation de suppression */}
      {supprimerDossier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Overlay */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => setSupprimerDossier(null)}
          />
          {/* Contenu */}
          <div className="relative z-10 w-full max-w-md animate-in fade-in zoom-in-95 rounded-xl border border-border bg-card p-6 shadow-2xl">
            {/* Bouton fermer */}
            <button
              onClick={() => setSupprimerDossier(null)}
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Icône d'alerte */}
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <Trash2 className="h-6 w-6 text-destructive" />
            </div>

            <h2 className="mb-1 text-center text-lg font-semibold">
              Supprimer ce dossier ?
            </h2>
            <p className="mb-2 text-center text-sm text-muted-foreground">
              Vous êtes sur le point de supprimer le dossier suivant :
            </p>
            <div className="mb-5 rounded-lg border border-border bg-muted/50 px-4 py-3">
              <p className="text-sm font-medium">{supprimerDossier.acheteur}</p>
              <p className="text-xs text-muted-foreground">{supprimerDossier.objet}</p>
            </div>
            <p className="mb-5 text-center text-xs text-muted-foreground">
              Cette action est irréversible. Toutes les données associées seront définitivement perdues.
            </p>

            {/* Actions */}
            <div className="flex gap-3">
              <Button
                id="cancel-delete-dossier"
                variant="outline"
                className="flex-1"
                onClick={() => setSupprimerDossier(null)}
              >
                Annuler
              </Button>
              <Button
                id="confirm-delete-dossier"
                variant="destructive"
                className="flex-1"
                onClick={handleSupprimer}
              >
                <Trash2 className="h-4 w-4" />
                Supprimer
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modale de confirmation de suppression multiple */}
      {supprimerMultiple && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => setSupprimerMultiple(false)}
          />
          <div className="relative z-10 w-full max-w-md animate-in fade-in zoom-in-95 rounded-xl border border-border bg-card p-6 shadow-2xl">
            <button
              onClick={() => setSupprimerMultiple(false)}
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <Trash2 className="h-6 w-6 text-destructive" />
            </div>

            <h2 className="mb-1 text-center text-lg font-semibold">
              Supprimer {selectedIds.size} dossiers ?
            </h2>
            <p className="mb-5 text-center text-sm text-muted-foreground">
              Cette action est irréversible. Toutes les données associées seront définitivement perdues pour les dossiers sélectionnés.
            </p>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setSupprimerMultiple(false)}
              >
                Annuler
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleSupprimerMultiple}
              >
                <Trash2 className="h-4 w-4" />
                Supprimer {selectedIds.size} dossiers
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
