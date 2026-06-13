export type Statut = "Brouillon" | "En cours" | "À valider" | "Envoyé";

export interface Lot {
  numero: number;
  intitule: string;
  perimetre: string;
}

export interface DossierRow {
  id: string;
  acheteur: string;
  objet: string;
  lots: number[] | any[]; // updated to handle detailed lots from backend
  dateLimite: string; // ISO
  statut: Statut;
  responsable: string;
  ccag?: string;
  cpv?: string[];
  reference?: string;
  procedure?: string;
  plateforme?: string;
  dateVisite?: string;
  visiteObligatoire?: boolean;
  lieuVisite?: string;
  duree?: string;
  criteres?: any;
  pieces_candidature?: any[];
  pieces_offre?: any[];
}

export interface SousCritere {
  libelle: string;
  points: number;
  lots: number[]; // [] = tous lots
  axe: "technique" | "prix";
}

export interface Piece {
  nom: string;
  obligatoire: boolean;
  alternative: string | null;
  etat: "obtenu" | "attente" | "manquant" | "na";
  ref: string;
}

export interface RagSource {
  categorie: string;
  fichier: string;
  extrait: string;
}

export interface MemoireSection {
  id: string;
  num: string;
  titre: string;
  points: number;
  lots: number[];
  statut: "draft" | "validee";
  contenu: string;
  sources: RagSource[];
}

export interface DceFile {
  nom: string;
  type: string;
  taille: string;
  statut: "ok" | "parsing" | "erreur";
}

export const STATUT_VARIANT: Record<Statut, "secondary" | "default" | "warning" | "success"> = {
  Brouillon: "secondary",
  "En cours": "default",
  "À valider": "warning",
  Envoyé: "success",
};

export function joursRestants(iso: string): number {
  if (!iso) return 0;
  const now = new Date(); 
  const target = new Date(iso);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function formatDateHeure(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface OptionCochee {
  label: string;
  checked: boolean;
}
export interface Contact {
  nom: string;
  fonction: string;
  tel: string;
  email: string;
}

export const IDENTITE_CANDIDAT = {
  denomination: "GSS — Sécurité privée",
  num_cnaps: "AUT-076-2122-12-15-20230456789",
  date_autorisation: "15 décembre 2023",
};

// Sections defaults if not populated
export const DEFAULT_SECTION_I = {
  num: "I",
  titre: "Moyens humains affectés spécifiquement au marché",
  points: 20,
  sousQuestions: [],
  soustraitance: {
    label: "Utilisation envisagée de la sous-traitance pour les prestations fixes ou supplémentaires",
    options: [
      { label: "Oui (niveau N-1)", checked: false },
      { label: "Oui (niveau N-2 en cascade)", checked: false },
      { label: "Non", checked: true },
    ],
  },
  dispositifAbsence: {
    label: "Dispositif prévu pour pallier à l'absence d'un ou plusieurs agents à leur poste",
    reponse: "",
  },
  interlocuteurPrincipal: {
    label: "Coordonnées de l'interlocuteur principal pour la gestion opérationnelle du marché",
    contact: { nom: "", fonction: "", tel: "", email: "" },
  },
  interlocuteurDevis: {
    label: "Coordonnées de l'interlocuteur pour la réalisation des devis concernant les prestations à la demande",
    contact: { nom: "", fonction: "", tel: "", email: "" },
  },
};

export const DEFAULT_SECTION_IV = {
  num: "IV",
  titre: "Télésurveillance et modalités d'intervention",
  points: 40,
  lotNote: "À remplir uniquement en cas de candidature et d'offre au lot 3.",
  apsad: {
    label: "Certification de service APSAD R 31",
    options: [
      { label: "P2", checked: false },
      { label: "P3", checked: true },
      { label: "P5", checked: false },
    ],
  },
  localisation: { label: "Localisation de la station de télésurveillance", reponse: "" },
  soustraitanceLeverDoute: { label: "La prestation d'intervention (lever de doute) est-elle sous-traitée ?", departements: [] },
  reportAlarmes: { label: "Observations techniques sur le report des alarmes intrusions, technique ou incendie", reponse: "" },
  moyensOuverture: { label: "Moyens d'ouverture des locaux pour la levée de doute", reponse: "" },
  delaisLabel: "Délais contractuels maximums d'intervention en cas de déclenchement d'alarme pour parvenir sur chaque site",
  intervenantsLabel: "Nombre d'intervenants véhiculés disponibles les soirs de week-end et jours fériés à moins de 20 km",
};
