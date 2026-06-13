import { SourceMeta } from './common';

export enum TypePrestation {
  BASE = 'base',
  SUPPLEMENTAIRE = 'supplementaire',
  TELESECURITE = 'telesecurite',
}

export enum CategorieExigence {
  QUALIFICATION = 'qualification',
  EQUIPEMENT = 'equipement',
  TENUE = 'tenue',
  COMPORTEMENT = 'comportement',
  VEHICULE = 'vehicule',
  AUTRE = 'autre',
}

export interface SectionCCTP {
  niveau: number;
  numero: string | null;
  titre: string;
  texte: string;
  enfants: SectionCCTP[];
}

export interface Prestation {
  type: TypePrestation;
  lot: number | null;
  campus: string | null;
  description: string;
  ref_section: string | null;
}

export interface ExigenceAgent {
  categorie: CategorieExigence;
  libelle: string;
  valeur: string | null;
  ref_section: string | null;
}

export interface CCTPDocument {
  objet: string | null;
  arborescence: SectionCCTP[];
  prestations: Prestation[];
  exigences_agents: ExigenceAgent[];
  contraintes_site: string[];
  reprise_personnel: boolean | null;
  source: SourceMeta;
}
