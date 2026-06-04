/**
 * Modèle de document partagé par les deux générateurs (DOCX & PDF).
 *
 * Objectif : une SEULE source de vérité pour l'en-tête, la signature, le nom de
 * fichier et la police, afin que le .docx et le .pdf restent cohérents entre eux
 * et fidèles à l'écran 6. Les sections elles-mêmes proviennent de mock-data.ts
 * (IDENTITE_CANDIDAT, SECTION_I..IV, DELAIS_INTERVENTION, NB_INTERVENANTS_WE_JF).
 */
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

/** Police des fichiers exportés (Helvetica/Arial — garantie côté lecteurs
 *  Word/PDF, contrairement à Inter qui n'est pas toujours installée). */
export const EXPORT_FONT = "Helvetica";

/** Nom de fichier (sans extension) des livrables. */
export const EXPORT_FILENAME = "Memoire_Technique_GSS_Univ_Rouen_MP2026-08";

/** En-tête du document. */
export const DOC_HEADER = {
  surtitre: "MÉMOIRE TECHNIQUE — CADRE DE RÉPONSE",
  titre: ROUEN.objet,
  acheteur: ROUEN.acheteur,
  reference: ROUEN.reference,
  remiseLe: formatDate(ROUEN.dateLimite),
  candidat: "GSS — Sécurité privée",
};

/** Bloc signature (bas de document, aligné à droite). */
export const SIGNATURE = {
  lieu: "Rouen",
  date: formatDate(ROUEN.dateLimite),
  entreprise: "GSS — Sécurité privée",
  signataire: "Mme Vaché, Responsable réponse AO",
  mention: "[Signature électronique]",
};

/** Ré-export regroupé des données de contenu (depuis mock-data). */
export const DOC_DATA = {
  identite: IDENTITE_CANDIDAT,
  sectionI: SECTION_I,
  sectionII: SECTION_II,
  sectionIII: SECTION_III,
  sectionIV: SECTION_IV,
  delais: DELAIS_INTERVENTION,
  nbIntervenants: NB_INTERVENANTS_WE_JF,
};

/** Caractères de case à cocher (rendu fidèle ☑ / ☐). */
export const CHECK_ON = "☑"; // ☑
export const CHECK_OFF = "☐"; // ☐
export function checkMark(checked: boolean): string {
  return checked ? CHECK_ON : CHECK_OFF;
}

/** Déclenche le téléchargement d'un Blob côté navigateur (sans dépendance). */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // libère l'URL objet après un court délai (laisse le temps au download)
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
