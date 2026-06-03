/**
 * Données de démonstration (maquette statique) — cas Université de Rouen
 * Normandie 2026-08, extraites par les parseurs RC/CCTP de l'itération 1
 * (gss-ao/data/output/rc_rouen.json + cctp_rouen.json).
 *
 * Aucune donnée n'est appelée via API : tout est figé ici pour la maquette.
 */

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
  lots: number[];
  dateLimite: string; // ISO
  statut: Statut;
  responsable: string;
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

/* ----------------------------------------------------- Liste des dossiers */
export const DOSSIERS: DossierRow[] = [
  {
    id: "rouen-2026-08",
    acheteur: "Université de Rouen Normandie",
    objet: "Prestations de sécurité-sûreté",
    lots: [1, 2, 3],
    dateLimite: "2026-04-08T11:00:00",
    statut: "En cours",
    responsable: "Mme Vaché",
  },
  {
    id: "chu-caen-2026-12",
    acheteur: "CHU de Caen",
    objet: "Gardiennage et contrôle d'accès hospitalier",
    lots: [1],
    dateLimite: "2026-04-22T12:00:00",
    statut: "Brouillon",
    responsable: "Sacha",
  },
  {
    id: "mairie-havre-2026-05",
    acheteur: "Ville du Havre",
    objet: "Surveillance de bâtiments municipaux",
    lots: [1, 2],
    dateLimite: "2026-04-15T17:00:00",
    statut: "À valider",
    responsable: "M. Marchani",
  },
  {
    id: "region-normandie-2026-03",
    acheteur: "Région Normandie",
    objet: "Télésurveillance des lycées",
    lots: [1],
    dateLimite: "2026-03-30T16:00:00",
    statut: "Envoyé",
    responsable: "Mme Vaché",
  },
  {
    id: "univ-lehavre-2025-44",
    acheteur: "Université Le Havre Normandie",
    objet: "Sûreté des campus et résidences",
    lots: [1, 2],
    dateLimite: "2026-05-06T11:00:00",
    statut: "Brouillon",
    responsable: "Sacha",
  },
];

/* ----------------------------------------- Détail du dossier Univ Rouen */
export const ROUEN = {
  id: "rouen-2026-08",
  objet: "Prestations de sécurité-sûreté pour l'Université de Rouen Normandie",
  acheteur: "Université de Rouen Normandie",
  ccag: "FCS",
  cpv: "79713000-5",
  reference: "MP 2026-08",
  procedure: "Appel d'Offres Ouvert (AOO)",
  plateforme: "achatpublic.com",
  dateLimite: "2026-04-08T11:00:00",
  dateVisite: "2026-03-16T10:00:00",
  visiteObligatoire: true,
  lieuVisite: "Campus Mont-Saint-Aignan — bâtiment des Affaires Générales (26A)",
  duree: "1 an reconductible 3 fois (4 ans max), effet au 5 juillet 2026",
  responsable: "Mme Vaché",
  statut: "En cours" as Statut,
  lots: [
    { numero: 1, intitule: "Sécurisation des campus du département 76", perimetre: "Seine-Maritime (76)" },
    { numero: 2, intitule: "Sécurisation des campus du département 27", perimetre: "Eure (27)" },
    { numero: 3, intitule: "Prestations de télé-sécurité", perimetre: "Tous campus" },
  ] as Lot[],
};

export const CRITERES: SousCritere[] = [
  { libelle: "Moyens humains affectés", points: 20, lots: [1, 2], axe: "technique" },
  { libelle: "Moyens matériels affectés", points: 20, lots: [1, 2], axe: "technique" },
  { libelle: "Télésurveillance et modalités d'intervention", points: 40, lots: [3], axe: "technique" },
  { libelle: "Mise en œuvre de plans de qualité", points: 10, lots: [], axe: "technique" },
  { libelle: "Prise en compte du développement durable", points: 10, lots: [], axe: "technique" },
  { libelle: "DPGF (prestations de base)", points: 30, lots: [], axe: "prix" },
  { libelle: "BPU (prestations supplémentaires)", points: 10, lots: [], axe: "prix" },
];
export const SCORE_TECHNIQUE = 60;
export const SCORE_PRIX = 40;

export const PIECES_CANDIDATURE: Piece[] = [
  { nom: "DC1 — Lettre de candidature", obligatoire: true, alternative: "DUME", etat: "obtenu", ref: "RC §4.1" },
  { nom: "DC2 — Déclaration du candidat", obligatoire: true, alternative: "DUME", etat: "obtenu", ref: "RC §4.1" },
  { nom: "Déclaration sur l'honneur", obligatoire: true, alternative: null, etat: "obtenu", ref: "RC §4.1" },
  { nom: "Note de présentation de l'entreprise", obligatoire: true, alternative: null, etat: "attente", ref: "RC §4.1" },
  { nom: "Liste de références (< 3 ans)", obligatoire: true, alternative: null, etat: "attente", ref: "RC §4.1" },
  { nom: "Attestation de régularité fiscale", obligatoire: true, alternative: null, etat: "manquant", ref: "RC §4.1" },
  { nom: "Attestations d'assurance", obligatoire: true, alternative: null, etat: "obtenu", ref: "RC §4.1" },
  { nom: "RIB de l'entreprise", obligatoire: true, alternative: null, etat: "obtenu", ref: "RC §4.1" },
];

export const PIECES_OFFRE: Piece[] = [
  { nom: "Acte d'Engagement (daté et signé)", obligatoire: true, alternative: null, etat: "attente", ref: "RC §4.2" },
  { nom: "BPU — Bordereau de Prix Unitaire", obligatoire: true, alternative: null, etat: "attente", ref: "RC §4.2" },
  { nom: "DPGF — Décomposition du Prix Global", obligatoire: true, alternative: null, etat: "manquant", ref: "RC §4.2" },
  { nom: "Mémoire technique (cadre imposé)", obligatoire: true, alternative: null, etat: "attente", ref: "RC §4.2" },
  { nom: "RIB de l'entreprise", obligatoire: true, alternative: null, etat: "obtenu", ref: "RC §4.2" },
];

/* ------------------------------------- Mémoire technique (cadre imposé) */
export const MEMOIRE_SECTIONS: MemoireSection[] = [
  {
    id: "I",
    num: "I",
    titre: "Moyens humains affectés au marché",
    points: 20,
    lots: [1, 2],
    statut: "validee",
    contenu:
      "GSS affecte aux campus de l'Université de Rouen Normandie une équipe dédiée, " +
      "encadrée par un chef d'équipe SSIAP2 coordinateur sûreté-sécurité et son adjoint. " +
      "Conformément au CCTP, l'ensemble des agents en poste fait l'objet d'une reprise du " +
      "personnel (art. L1224-1) garantissant la continuité de service.\n\n" +
      "Qualifications : agents APS titulaires de la carte professionnelle CNAPS, SSIAP1 pour " +
      "les postes incendie, recyclages à jour (SST, H0B0). Le dispositif palliatif d'absence " +
      "repose sur un volant de remplacement régional mobilisable sous 1h et une astreinte 24/7.\n\n" +
      "Interlocuteur unique : un responsable de site joignable en permanence, doublé d'un " +
      "interlocuteur dédié aux devis de prestations supplémentaires à la demande.",
    sources: [
      { categorie: "Formation", fichier: "FORMATION AGENT SSIAP1 3.pdf", extrait: "Cursus SSIAP1 et recyclage triennal des agents incendie." },
      { categorie: "Effectifs", fichier: "ORGANIGRAMME GSS.pdf", extrait: "Organigramme opérationnel et effectifs moyens par site." },
      { categorie: "Recrutement", fichier: "METHODE RECRUTEMENT 1.pdf", extrait: "Process de sélection et vérification carte CNAPS." },
      { categorie: "Absence et retard", fichier: "REMPLACEMENT AGENT 2.pdf", extrait: "Procédure de remplacement < 1h via volant régional." },
    ],
  },
  {
    id: "II",
    num: "II",
    titre: "Moyens matériels affectés au marché",
    points: 20,
    lots: [1, 2],
    statut: "draft",
    contenu:
      "Chaque agent est doté d'un équipement individuel complet (tenue GSS identifiable, " +
      "chaussures de sécurité, lampe, moyen de communication) et des EPI requis par les " +
      "zones à régime restrictif (ZRR) identifiées au CCTP.\n\n" +
      "La traçabilité des rondes et des incidents est assurée par l'outil de main courante " +
      "électronique Track Force (horodatage, pointeaux, rapports automatisés transmis au " +
      "client). Les moyens d'accès (badges, clés) sont gérés selon une procédure de perception " +
      "et de restitution contrôlée.",
    sources: [
      { categorie: "Matériel", fichier: "MATERIEL COMMUNICATION 2.pdf", extrait: "Dotation radio et PTI des agents." },
      { categorie: "Main courante", fichier: "TRACK FORCE 1.pdf", extrait: "Main courante électronique et reporting client." },
      { categorie: "Tenues", fichier: "TENUE AGENT 1.pdf", extrait: "Tenue d'uniforme GSS et EPI." },
      { categorie: "Moyens d'accès", fichier: "SECURISATION ACCES 1.pdf", extrait: "Gestion des badges et clés." },
    ],
  },
  {
    id: "III",
    num: "III",
    titre: "Organisation interne, qualité et environnement",
    points: 20,
    lots: [],
    statut: "draft",
    contenu:
      "Le pilotage de la prestation s'appuie sur un management de proximité et un plan de " +
      "contrôle qualité : contrôles inopinés, audits périodiques et indicateurs partagés avec " +
      "l'Université. La mise en place du marché suit un processus de démarrage formalisé " +
      "(reprise du personnel, briefings, livre de consignes).\n\n" +
      "Performance environnementale : véhicules à faibles émissions pour les rondes, " +
      "dématérialisation des rapports, démarche RSE GSS (tri, sensibilisation des agents).",
    sources: [
      { categorie: "Management", fichier: "VALEURS MANAGMENT 1.pdf", extrait: "Management de proximité et valeurs GSS." },
      { categorie: "Suivi qualité", fichier: "CONTROLES INOPINES 2.pdf", extrait: "Plan de contrôle qualité et audits." },
      { categorie: "Mise en place", fichier: "DEMARRAGE PRESTATION.pdf", extrait: "Processus de démarrage d'un nouveau marché." },
      { categorie: "Engagement écologique", fichier: "DEMARCHE RSE 2.pdf", extrait: "Engagement développement durable." },
    ],
  },
  {
    id: "IV",
    num: "IV",
    titre: "Télésurveillance et modalités d'intervention",
    points: 40,
    lots: [3],
    statut: "draft",
    contenu:
      "GSS opère une station de télésurveillance certifiée APSAD P3, assurant le report des " +
      "alarmes intrusion, technique et incendie pour l'ensemble des campus. Le lever de doute " +
      "vidéo est complété, si nécessaire, par l'intervention d'agents véhiculés.\n\n" +
      "Couverture des départements 76 et 27 : intervenants mobilisables en moins de 20 km, " +
      "week-ends et jours fériés inclus, dans le respect des délais contractuels maximaux " +
      "d'intervention. Les moyens d'ouverture pour lever de doute sont prévus par convention.",
    sources: [
      { categorie: "Procédure", fichier: "GESTION D'UNE INTERVENTION ALARME 1.pdf", extrait: "Procédure d'intervention sur alarme." },
      { categorie: "Procédure", fichier: "GESTION D'UNE INTRUSION 2.pdf", extrait: "Conduite à tenir en cas d'intrusion." },
      { categorie: "Partenaires", fichier: "PARTENAIRES INTERVENTION 5.pdf", extrait: "Réseau de partenaires lever de doute." },
      { categorie: "Matériel", fichier: "MATERIEL TELESURVEILLANCE.pdf", extrait: "Équipement station de télésurveillance." },
    ],
  },
];

/* ------------------------------------------------- Upload DCE (écran 2) */
export const DCE_FILES: DceFile[] = [
  { nom: "1-Acte d'Engagement.doc", type: "Acte d'Engagement", taille: "143 Ko", statut: "ok" },
  { nom: "2-RC 2026-08.doc", type: "RC", taille: "121 Ko", statut: "ok" },
  { nom: "3-CCAP 2026-08.docx", type: "CCAP", taille: "328 Ko", statut: "ok" },
  { nom: "4-CCTP 2026-08.docx", type: "CCTP", taille: "1,8 Mo", statut: "ok" },
  { nom: "5-Mémoire Technique - lots 1-2-3.docx", type: "Mémoire (cadre)", taille: "301 Ko", statut: "ok" },
  { nom: "6-DPGF et BPU - lot 1 - sites 76.docx", type: "BPU / DPGF", taille: "305 Ko", statut: "ok" },
  { nom: "6-DPGF et BPU - lot 2 - sites 27.docx", type: "BPU / DPGF", taille: "302 Ko", statut: "parsing" },
  { nom: "6-BPU - lot 3 - télésécurité.docx", type: "BPU / DPGF", taille: "298 Ko", statut: "parsing" },
];

/* ----------------------------------------------------------- Utilitaires */
export const STATUT_VARIANT: Record<Statut, "secondary" | "default" | "warning" | "success"> = {
  Brouillon: "secondary",
  "En cours": "default",
  "À valider": "warning",
  Envoyé: "success",
};

export function joursRestants(iso: string): number {
  const now = new Date("2026-03-12T09:00:00"); // "aujourd'hui" figé pour la maquette
  const target = new Date(iso);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function formatDateHeure(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
