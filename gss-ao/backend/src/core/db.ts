import fs from 'fs';
import path from 'path';

const DB_DIR = 'C:\\Users\\linal\\stanmerci\\mes dossiers';

// Ensure the directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export interface DossierRecord {
  id: string;
  acheteur: string;
  objet: string;
  lots: any[];
  dateLimite: string;
  statut: string;
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
  memoire_sections?: any[];
  dce_files?: any[];
  [key: string]: any;
}

export class DB {
  static getDossiers(): DossierRecord[] {
    const files = fs.readdirSync(DB_DIR);
    const dossiers: DossierRecord[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = fs.readFileSync(path.join(DB_DIR, file), 'utf-8');
          dossiers.push(JSON.parse(content));
        } catch (e) {
          console.error(`Error parsing ${file}`);
        }
      }
    }
    return dossiers;
  }

  static getDossier(id: string): DossierRecord | null {
    const file = path.join(DB_DIR, `${id}.json`);
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        return JSON.parse(content);
      } catch (e) {
        console.error(`Error reading ${file}`);
      }
    }
    return null;
  }

  static saveDossier(id: string, data: Partial<DossierRecord>): void {
    const file = path.join(DB_DIR, `${id}.json`);
    let existing = {};
    if (fs.existsSync(file)) {
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (e) {}
    }
    const updated = { ...existing, ...data, id };
    fs.writeFileSync(file, JSON.stringify(updated, null, 2));
  }

  static deleteDossier(id: string): void {
    const file = path.join(DB_DIR, `${id}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
