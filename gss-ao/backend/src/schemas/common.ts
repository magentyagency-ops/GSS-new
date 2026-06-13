export enum ExtractionMethod {
  DOCX_NATIVE = 'docx_native',
  DOC_LIBREOFFICE = 'doc_libreoffice',
  DOC_TEXTUTIL = 'doc_textutil',
  DOC_OLEFILE_FALLBACK = 'doc_olefile_fallback',
  PDF_PYMUPDF = 'pdf_pymupdf',
  PDF_PDFPLUMBER = 'pdf_pdfplumber',
  PDF_OCR = 'pdf_ocr',
}

export interface SourceMeta {
  fichier: string;
  methode_extraction: ExtractionMethod;
  warnings: string[];
}

export interface Lot {
  numero: number;
  intitule: string;
  perimetre: string | null;
}

export interface DateEcheance {
  libelle: string;
  valeur: string | null; // ISO Date String YYYY-MM-DD
  texte_brut: string | null;
}
