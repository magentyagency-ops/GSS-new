import { Router, Request, Response } from 'express';
import { MemoireGenerator } from '../generation/memoire_generator';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { DB, DossierRecord } from '../core/db';
import { parseCctp } from '../analysis/cctpParser';
import { parseRc } from '../analysis/rcParser';

const uploadDir = path.resolve(__dirname, '../../../data/output/temp');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

const router = Router();

// Probe / healthcheck
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Download a generated file
router.get('/download', (req: Request, res: Response) => {
  const filePath = req.query.file as string;
  if (!filePath) {
    return res.status(400).send('File path missing');
  }
  res.download(filePath);
});

// --- Dossiers Endpoints ---

router.get('/dossiers', (req: Request, res: Response) => {
  try {
    const dossiers = DB.getDossiers();
    res.json(dossiers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dossiers/:id', (req: Request, res: Response) => {
  try {
    const dossier = DB.getDossier(req.params.id);
    if (!dossier) return res.status(404).json({ error: 'Dossier not found' });
    res.json(dossier);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/dossiers', (req: Request, res: Response) => {
  try {
    const id = req.body.id || `dossier-${Date.now()}`;
    const data = { ...req.body, id };
    DB.saveDossier(id, data);
    res.json({ id, message: 'Dossier créé' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/dossiers/:id', (req: Request, res: Response) => {
  try {
    DB.deleteDossier(req.params.id);
    res.json({ message: 'Dossier supprimé' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Module A — upload ZIP/multi-fichiers + classification des pièces.
router.post('/dce/upload', upload.array('files'), (req: Request, res: Response) => {
  try {
    const dossierId = req.body.id;
    if (!dossierId) throw new Error("ID du dossier manquant");
    
    const targetDir = path.resolve(__dirname, `../../../data/output/dce_${dossierId}`);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    let rcData: any = null;
    let cctpData: any = null;

    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        // Renommer le fichier uploadé avec son nom original
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        const finalName = `${base}${ext}`;
        const finalPath = path.join(targetDir, finalName);
        fs.renameSync(file.path, finalPath);

        const lowerName = finalName.toLowerCase();
        // Extract features
        if (lowerName.includes('rc') || lowerName.includes('reglement')) {
          try {
            rcData = parseRc(finalPath);
          } catch (e) { console.warn("Erreur parsing RC:", e); }
        }
        if (lowerName.includes('cctp')) {
          try {
            cctpData = parseCctp(finalPath);
          } catch (e) { console.warn("Erreur parsing CCTP:", e); }
        }
      }
    }

    // Merge data from parsers
    const dossierUpdate: Partial<DossierRecord> = {};
    if (rcData) {
      if (rcData.acheteur) dossierUpdate.acheteur = rcData.acheteur;
      if (rcData.objet) dossierUpdate.objet = rcData.objet;
      if (rcData.allotissement) dossierUpdate.lots = rcData.allotissement;
      if (rcData.criteres) dossierUpdate.criteres = rcData.criteres;
      if (rcData.pieces_candidature) dossierUpdate.pieces_candidature = rcData.pieces_candidature;
      if (rcData.pieces_offre) dossierUpdate.pieces_offre = rcData.pieces_offre;
      if (rcData.modalites_remise?.date_limite?.valeur) {
        dossierUpdate.dateLimite = new Date(rcData.modalites_remise.date_limite.valeur).toISOString();
      }
    }
    if (cctpData) {
      if (cctpData.objet && !dossierUpdate.objet) dossierUpdate.objet = cctpData.objet;
    }

    dossierUpdate.statut = "En cours";
    DB.saveDossier(dossierId, dossierUpdate);
    
    res.json({ message: "Fichiers uploadés et parsés avec succès", dossierId, rcData, cctpData });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Module B — fiche de synthèse DCE.
router.get('/dce/:dossier_id/synthese', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Endpoint synthèse — itération ultérieure' });
});

// Module E — check-list de conformité.
router.get('/dce/:dossier_id/checklist', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Endpoint check-list — itération ultérieure' });
});

// Module C — génération mémoire technique.
router.post('/dce/:dossier_id/memoire', async (req: Request, res: Response) => {
  try {
    const generator = new MemoireGenerator();
    const result = await generator.generate(req.params.dossier_id);
    res.json({ message: 'Mémoire technique traité', file_path: result.filePath, data_generee_par_ia: result.generatedData });
  } catch (error: any) {
    console.error('Erreur lors de la génération du mémoire:', error);
    res.status(500).json({ error: error.message || 'Erreur interne du serveur' });
  }
});

// Assemble un .docx à partir des sections déjà générées (cas sans cadre imposé) :
// remplace le contenu de chaque chapitre du mémoire de référence GSS par le texte IA.
router.post('/dossiers/:id/memoire-from-sections', async (req: Request, res: Response) => {
  try {
    const { chapters } = req.body;
    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ error: 'Aucune section fournie.' });
    }
    const generator = new MemoireGenerator();
    const result = await generator.assembleFromSections(req.params.id, chapters);
    res.json({
      message: 'Mémoire technique assemblé',
      file_path: result.filePath,
      data_generee_par_ia: result.generatedData,
    });
  } catch (error: any) {
    console.error('Erreur assemblage mémoire:', error);
    res.status(500).json({ error: error.message || 'Erreur interne du serveur' });
  }
});

router.post('/generate-section', async (req: Request, res: Response) => {
  try {
    const { api_key, cctp_extract, rag_chunks, template_question, mode, selected_slides } = req.body;
    
    if (!api_key) {
      return res.status(400).json({ error: "Clé API OpenAI manquante." });
    }

    const openai = new OpenAI({ apiKey: api_key });
    
    let prompt = `Tu es un expert en réponse aux appels d'offres pour l'entreprise de sécurité privée GSS.\n`;
    prompt += `Ton objectif est de rédiger une section claire, professionnelle et convaincante pour le mémoire technique.\n\n`;
    
    if (cctp_extract) {
      prompt += `--- EXTRAIT DU CCTP (Attentes du client) ---\n${cctp_extract}\n\n`;
    }
    
    const chunks = mode === 'A' ? rag_chunks : selected_slides;
    if (chunks && chunks.length > 0) {
      prompt += `--- RESSOURCES GSS (À mobiliser dans la réponse) ---\n`;
      chunks.forEach((c: any, i: number) => {
        prompt += `Source ${i+1} [${c.categorie}]: ${c.texte}\n`;
      });
      prompt += `\n`;
    }

    if (mode === 'B' && template_question) {
      prompt += `La question ou thématique à traiter est : "${template_question}"\n\n`;
    }

    prompt += `Rédige la section de manière formelle et synthétique. N'inclus pas de salutations.\n`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.7,
    });

    const generated_text = completion.choices[0].message.content || "";
    const tokens_used = completion.usage?.total_tokens || 0;

    res.json({
      generated_text,
      model: "gpt-4o",
      tokens_used
    });
  } catch (error: any) {
    console.error('Erreur generate-section:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export DOCX (cas sans cadre imposé / Mode B) — comme GSS-MT-Generator :
// reçoit la map des sections générées, assemble le mémoire de référence GSS
// et renvoie le .docx en téléchargement direct (blob).
router.post('/export-docx', async (req: Request, res: Response) => {
  try {
    const { sections } = req.body;
    if (!sections || typeof sections !== 'object' || Object.keys(sections).length === 0) {
      return res.status(400).json({ error: 'Aucune section à exporter.' });
    }
    const generator = new MemoireGenerator();
    const result = await generator.exportFromSectionsMap(sections as Record<string, string>);
    return res.download(result.filePath, 'Memoire_Technique_GSS.docx');
  } catch (error: any) {
    console.error('Erreur export-docx:', error);
    res.status(500).json({ error: error.message || 'Erreur interne du serveur' });
  }
});

export default router;
