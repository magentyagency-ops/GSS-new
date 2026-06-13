"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Trash2,
  Sparkles,
  Circle,
  Shield,
  Building2,
  Table,
  Layers,
  X,
} from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { type DceFile, type DossierRow } from "@/lib/gss-config";
import { cn } from "@/lib/utils";

const TYPES = ["RC", "CCAP", "CCTP", "BPU / DPGF", "Mémoire (cadre)", "Acte d'Engagement", "Compte Rendu", "Annexe", "Inconnu"];

export default function NouveauDossierPage() {
  const router = useRouter();
  const [files, setFiles] = useState<(DceFile & { file?: File })[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const isAppendingRef = useRef(false);
  const [showQuitModal, setShowQuitModal] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);

  useEffect(() => {
    // Clean up local storage flag when arriving to guarantee a fresh session
    localStorage.removeItem("gss_cr_fourni");
  }, []);

  // Simulate automatic parsing completion after 1.5 seconds
  useEffect(() => {
    const hasParsing = files.some((f) => f.statut === "parsing");
    if (hasParsing) {
      const timer = setTimeout(() => {
        setFiles((prev) => prev.map((f) => (f.statut === "parsing" ? { ...f, statut: "ok" } : f)));
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [files]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      let isDceFolder = false;
      const newFiles = Array.from(e.target.files).map(file => {
        const nomLow = file.name.toLowerCase();
        let detectType = "Inconnu";
        
        // Match exact RC words to avoid false positives like 'commercial'
        const isAnnexe = /\b(annexe|annexes)\b/.test(nomLow);
        const isRC = /\b(rc|règlement|reglement)\b/.test(nomLow);
        const isCCTP = /\b(cctp)\b/.test(nomLow);
        const isCCAP = /\b(ccap)\b/.test(nomLow);
        const isCR = nomLow.includes("compte rendu") || nomLow.includes("visite") || /\bcr\b/.test(nomLow);
        const isBPU = nomLow.includes("bpu") || nomLow.includes("dpgf") || nomLow.includes("dqe");
        const isActe = nomLow.includes("acte") || nomLow.includes("engagement");
        const normalizedNom = nomLow.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const isMemoire = normalizedNom.includes("memoire") && (nomLow.endsWith(".doc") || nomLow.endsWith(".docx"));

        if (isAnnexe) detectType = "Annexe";
        else if (isRC) detectType = "RC";
        else if (isCCTP) detectType = "CCTP";
        else if (isCR) detectType = "Compte Rendu";
        else if (isCCAP) detectType = "CCAP";
        else if (isBPU) detectType = "BPU / DPGF";
        else if (isActe) detectType = "Acte d'Engagement";
        else if (isMemoire) detectType = "Mémoire (cadre)";

        // file.webkitRelativePath might look like "DCE/mon_fichier.pdf"
        const relativePath = (file as any).customPath || file.webkitRelativePath || file.name;
        if (relativePath.includes("/")) {
          isDceFolder = true;
        }
        return {
          nom: relativePath,
          type: detectType,
          taille: (file.size / 1024).toFixed(0) + " Ko",
          statut: "parsing" as const,
          file: file
        };
      });

      if (isDceFolder) {
        localStorage.setItem("gss_cr_fourni", "true");
      }

      if (isAppendingRef.current) {
        setFiles(prev => [...prev, ...newFiles]);
      } else {
        setFiles(newFiles);
      }
      isAppendingRef.current = false; // Reset after use
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);

    if (!e.dataTransfer.items) {
      // Fallback for old browsers
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        isAppendingRef.current = false;
        handleFileChange({ target: { files: e.dataTransfer.files } } as any);
      }
      return;
    }

    const filesToProcess: File[] = [];

    const getFilesFromEntry = async (entry: any): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve) => entry.file(resolve));
        // Force the relative path so the rest of the code knows it's a folder structure
        try {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: entry.fullPath.substring(1), // remove leading '/'
            writable: false
          });
        } catch (e) {
          // Si le navigateur bloque la redéfinition, on utilise une propriété custom
          (file as any).customPath = entry.fullPath.substring(1);
        }
        filesToProcess.push(file);
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const readAllEntries = async (): Promise<any[]> => {
          let allEntries: any[] = [];
          const readBatch = async () => {
            const entries = await new Promise<any[]>((resolve) => dirReader.readEntries(resolve));
            if (entries.length > 0) {
              allEntries = allEntries.concat(entries);
              await readBatch();
            }
          };
          await readBatch();
          return allEntries;
        };
        const entries = await readAllEntries();
        for (const child of entries) {
          await getFilesFromEntry(child);
        }
      }
    };

    const promises = [];
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.webkitGetAsEntry) {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          promises.push(getFilesFromEntry(entry));
        }
      }
    }

    await Promise.all(promises);

    if (filesToProcess.length > 0) {
      isAppendingRef.current = false; // Drag and drop replaces everything
      handleFileChange({ target: { files: filesToProcess } } as any);
    }
  }

  const tousParses = files.length > 0 && files.every((f) => f.statut === "ok");
  const enCours = files.filter((f) => f.statut === "parsing").length;

  const hasRC = files.some(f => f.type === "RC");
  const hasCCTP = files.some(f => f.type === "CCTP");
  const hasCCAP = files.some(f => f.type === "CCAP");
  const hasBPU = files.some(f => f.type === "BPU / DPGF");
  const isPrerequisOk = hasRC && hasCCTP && hasCCAP && hasBPU;

  let missingReason = "";
  if (!tousParses) {
    missingReason = "Fichiers en cours d'analyse...";
  } else if (!isPrerequisOk) {
    const missing = [];
    if (!hasRC) missing.push("RC");
    if (!hasCCTP) missing.push("CCTP");
    if (!hasCCAP) missing.push("CCAP");
    if (!hasBPU) missing.push("BPU / DPGF");
    missingReason = `Prérequis manquants : ${missing.join(", ")}`;
  }

  function terminerParsing() {
    setFiles((prev) => prev.map((f) => (f.statut === "parsing" ? { ...f, statut: "ok" } : f)));
  }
  function setType(nom: string, type: string) {
    setFiles((prev) => prev.map((f) => (f.nom === nom ? { ...f, type } : f)));
  }
  function remove(nom: string) {
    setFiles((prev) => prev.filter((f) => f.nom !== nom));
  }

  async function saveDossier(isBrouillon: boolean): Promise<string> {
    const dossierId = `dossier-${Date.now()}`;

    // Extraire le nom du dossier DCE depuis les chemins des fichiers uploadés
    let dossierName = "";
    for (const f of files) {
      if (f.nom.includes("/")) {
        // Le premier segment du chemin est le nom du dossier DCE
        dossierName = f.nom.split("/")[0];
        break;
      }
    }
    // Nettoyer le nom (enlever "DCE" redondant au début, etc.)
    if (dossierName) {
      dossierName = dossierName.replace(/^DCE\s*/i, "").trim();
    }

    const newDossier = {
      id: dossierId,
      objet: dossierName || "Dossier " + new Date().toLocaleDateString("fr-FR"),
      lots: [],
      dateLimite: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString(),
      statut: isBrouillon ? "Brouillon" : "En cours",
      responsable: "Sacha",
      dce_files: files.map(f => ({ ...f, file: undefined })),
    };

    try {
      await fetch("http://localhost:8000/api/dossiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newDossier),
      });
    } catch (e) {
      console.error("Impossible de sauvegarder le dossier sur le serveur", e);
    }

    return dossierId;
  }

  function handleQuit() {
    if (files.length > 0) {
      setShowQuitModal(true);
    } else {
      router.push("/");
    }
  }

  const isQuittingRef = useRef(false);

  async function handleConfirmQuit(save: boolean) {
    if (isQuittingRef.current) return;
    isQuittingRef.current = true;
    if (save) {
      await saveDossier(true);
    }
    router.push("/");
  }

  async function handleLaunch() {
    if (isLaunching) return;
    setIsLaunching(true);
    const dossierId = await saveDossier(false);
    
    // Uploader les fichiers vers le backend
    try {
      const formData = new FormData();
      formData.append("id", dossierId);
      files.forEach((f) => {
        if (f.file) {
          formData.append("files", f.file);
        }
      });
      const res = await fetch("http://localhost:8000/api/dce/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        console.warn("Erreur lors de l'envoi des fichiers au serveur.");
      }
    } catch (e) {
      console.error("Impossible de joindre le serveur pour l'upload", e);
    }

    router.push(`/dossiers/${dossierId}`);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Nouveau dossier — dépôt du DCE</h1>
          <p className="text-sm text-muted-foreground">
            Déposez l'ensemble des pièces du Dossier de Consultation (PDF, DOCX, DOC). Le type de
            chaque pièce est détecté automatiquement.
          </p>
        </div>
        <Button variant="outline" onClick={handleQuit}>
          <X className="mr-2 h-4 w-4" /> Quitter
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={cn(
              "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
              dragOver ? "border-primary bg-accent" : "border-border bg-card",
            )}
          >
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div className="text-sm font-medium">Glissez-déposez le dossier DCE complet ici</div>
            <div className="mt-1 text-xs text-muted-foreground">
              ou cliquez sur le bouton pour sélectionner votre dossier
            </div>
            <input 
              type="file" 
              multiple 
              className="hidden" 
              ref={fileInputRef} 
              onChange={handleFileChange} 
            />
            {/* Input specifically for Folder Upload */}
            <input 
              type="file" 
              multiple 
              // @ts-ignore - webkitdirectory is non-standard but works in all modern browsers
              webkitdirectory=""
              directory=""
              className="hidden" 
              ref={folderInputRef} 
              onChange={handleFileChange} 
            />
            <div className="flex gap-3 mt-4">
              {files.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => { isAppendingRef.current = true; fileInputRef.current?.click(); }}>
                  Ajouter des fichiers
                </Button>
              )}
              <Button variant="default" size="sm" onClick={() => { isAppendingRef.current = false; folderInputRef.current?.click(); }}>
                Déposer un dossier "DCE"
              </Button>
            </div>
          </div>

          {/* Required Slots */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Prérequis de l'IA (Required)</h2>
            <div className="grid gap-3">
              {[
                { type: "CCTP", label: "CCTP / CCP (Exigences techniques)", icon: Shield, missingBadge: "REQUIS", missingColor: "destructive" },
                { type: "RC", label: "Règlement de Consultation (RC)", icon: FileText, missingBadge: "REQUIS", missingColor: "destructive" },
                { type: "CCAP", label: "Cahier des Clauses Administratives Particulières (CCAP)", icon: FileText, missingBadge: "REQUIS", missingColor: "destructive" },
                { type: "Compte Rendu", label: "Rapport de Visite de Sacha", icon: Building2, missingBadge: "RECOMMANDÉ (60% VALEUR)", missingColor: "warning" },
                { type: "BPU / DPGF", label: "BPU / DPGF (Chiffrage)", icon: Table, missingBadge: "REQUIS", missingColor: "destructive" },
                { type: "Mémoire (cadre)", label: "Template Mémoire Client (.docx)", icon: Layers, missingBadge: "NON DÉTECTÉ", missingColor: "destructive" },
              ].map((slot) => {
                const foundFile = files.find((f) => f.type === slot.type);
                const Icon = slot.icon;
                
                if (foundFile) {
                  return (
                    <div key={slot.type} className="flex items-center gap-4 rounded-md border border-border bg-card/60 px-5 py-4 shadow-sm relative overflow-hidden">
                      <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-success"></div>
                      <Icon className="h-5 w-5 text-success" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{slot.label}</div>
                        {slot.type === "Mémoire (cadre)" && (
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            <span className="truncate">{foundFile.nom}</span>
                          </div>
                        )}
                      </div>
                      {slot.type === "Mémoire (cadre)" ? (
                        <div className="rounded bg-success/20 px-2.5 py-1 text-xs font-semibold text-success border border-success/30">
                          ✓ DÉTECTÉ – MODE WORD A-Z
                        </div>
                      ) : (
                        <div className="rounded bg-success/10 px-2.5 py-1 text-xs font-semibold text-success border border-success/20">
                          PRÉSENT
                        </div>
                      )}
                    </div>
                  );
                } else {
                  const isWarning = slot.missingColor === "warning";
                  return (
                    <div key={slot.type} className="flex items-center gap-4 rounded-md border border-border bg-card/40 px-5 py-4 shadow-sm relative overflow-hidden opacity-90">
                      <div className={cn("absolute left-0 top-0 bottom-0 w-1.5", isWarning ? "bg-amber-500" : "bg-destructive")}></div>
                      <Icon className={cn("h-5 w-5", isWarning ? "text-amber-500" : "text-destructive/70")} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{slot.label}</div>
                      </div>
                      <div className={cn(
                        "rounded px-2.5 py-1 text-xs font-semibold border",
                        isWarning ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : "bg-destructive/10 text-destructive border-destructive/20"
                      )}>
                        {slot.missingBadge}
                      </div>
                    </div>
                  );
                }
              })}
            </div>
          </div>

          {/* Fichiers scannés */}
          {files.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-4 text-lg font-semibold">Fichiers scannés dans le dossier</h2>
              <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3 bg-muted/30">
                <div className="text-sm font-semibold">Tous les fichiers ({files.length})</div>
                {enCours > 0 && (
                  <Button size="sm" variant="outline" className="h-7 text-xs bg-white" onClick={terminerParsing}>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Forcer la fin du parsing
                  </Button>
                )}
              </div>
              <div className="divide-y divide-border max-h-60 overflow-y-auto">
                {files.map((f) => (
                  <div key={f.nom} className="flex items-center gap-3 px-4 py-2.5">
                    <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{f.nom}</div>
                      <div className="text-xs text-muted-foreground">{f.taille}</div>
                    </div>

                    {/* Type détecté (éditable) */}
                    <select
                      value={f.type}
                      onChange={(e) => setType(f.nom, e.target.value)}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>

                    {/* Statut parsing */}
                    <div className="w-24 text-right">
                      {f.statut === "ok" && (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <CheckCircle2 className="h-4 w-4" /> Analysé
                        </span>
                      )}
                      {f.statut === "parsing" && (
                        <span className="inline-flex items-center gap-1 text-xs text-warning">
                          <Loader2 className="h-4 w-4 animate-spin" /> Parsing…
                        </span>
                      )}
                      {f.statut === "erreur" && (
                        <span className="inline-flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="h-4 w-4" /> Erreur
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => remove(f.nom)}
                      className="text-muted-foreground hover:text-destructive"
                      title="Retirer"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
            </div>
          )}

          {/* Action */}
          <div className="flex items-center justify-between mt-6">
            <p className="text-sm text-muted-foreground">
              {isPrerequisOk && tousParses
                ? "Tous les prérequis sont validés — vous pouvez lancer l'analyse complète."
                : "Les prérequis obligatoires (RC, CCTP, CR) doivent être renseignés et parsés."}
            </p>
            {isPrerequisOk && tousParses ? (
              <Button onClick={handleLaunch} disabled={isLaunching}>
                {isLaunching ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                {isLaunching ? "Lancement en cours..." : "Lancer l'analyse"}
              </Button>
            ) : (
              <div title={`Bloqué — ${missingReason}`} className="cursor-help">
                <Button disabled className="pointer-events-none">
                  <Sparkles className="h-4 w-4 mr-2" /> Lancer l'analyse
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal de confirmation pour quitter */}
      {showQuitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowQuitModal(false)} />
          <div className="relative z-10 w-full max-w-md animate-in fade-in zoom-in-95 rounded-xl border border-border bg-card p-6 shadow-2xl">
            <h2 className="mb-2 text-center text-lg font-semibold">
              Sauvegarder en brouillon ?
            </h2>
            <p className="mb-6 text-center text-sm text-muted-foreground">
              Vous êtes sur le point de quitter la création. Voulez-vous conserver les fichiers actuels en tant que brouillon pour y revenir plus tard ?
            </p>
            <div className="flex flex-col gap-3">
              <Button variant="default" onClick={() => handleConfirmQuit(true)}>
                Oui, sauvegarder en brouillon
              </Button>
              <Button variant="outline" onClick={() => handleConfirmQuit(false)} className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/20">
                Non, quitter sans sauvegarder
              </Button>
              <Button variant="ghost" onClick={() => setShowQuitModal(false)}>
                Annuler
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
