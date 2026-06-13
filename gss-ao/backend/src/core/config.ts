import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export enum EmbeddingProvider {
  VOYAGE = 'voyage',
  OPENAI = 'openai',
  BGE_LOCAL = 'bge_local',
  NONE = 'none',
}

export enum VectorStoreBackend {
  JSONL = 'jsonl',
  PGVECTOR = 'pgvector',
}

export interface Settings {
  corpusDceDir: string;
  corpusSlideRepAoDir: string;
  sofficeBin: string;
  ocrEnabled: boolean;
  tesseractBin: string;
  ocrLang: string;
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
  embeddingDim: number;
  voyageApiKey: string;
  openaiApiKey: string;
  vectorStore: VectorStoreBackend;
  vectorStoreJsonlPath: string;
  databaseUrl: string;
  anthropicApiKey: string;
  llmModelLong: string;
  llmModelUtility: string;
  s3EndpointUrl: string;
  s3Bucket: string;
}

export function getSettings(): Settings {
  const baseDir = path.resolve(__dirname, '../../../');
  
  let dceDir = process.env.CORPUS_DCE_DIR;
  if (!dceDir) {
    try {
      const parentDir = path.resolve(baseDir, '../');
      const dirs = fs.readdirSync(parentDir, { withFileTypes: true });
      const found = dirs.find(d => 
        d.isDirectory() && 
        d.name.toUpperCase().includes('DCE') && 
        !d.name.toLowerCase().includes('cas-univ')
      );
      if (found) {
        dceDir = `../${found.name}`;
      } else {
        dceDir = '../Cas-Univ-Rouen-MP2026-08';
      }
    } catch (e) {
      dceDir = '../Cas-Univ-Rouen-MP2026-08';
    }
  }

  const slideDir = process.env.CORPUS_SLIDE_REP_AO_DIR || '../SLIDE REP AO';
  const jsonlPath = process.env.VECTOR_STORE_JSONL_PATH || 'data/output/slide_rep_ao_chunks.jsonl';

  return {
    corpusDceDir: path.isAbsolute(dceDir) ? dceDir : path.resolve(baseDir, dceDir),
    corpusSlideRepAoDir: path.isAbsolute(slideDir) ? slideDir : path.resolve(baseDir, slideDir),
    sofficeBin: process.env.SOFFICE_BIN || '',
    ocrEnabled: process.env.OCR_ENABLED === 'true',
    tesseractBin: process.env.TESSERACT_BIN || '',
    ocrLang: process.env.OCR_LANG || 'fra',
    embeddingProvider: (process.env.EMBEDDING_PROVIDER as EmbeddingProvider) || EmbeddingProvider.NONE,
    embeddingModel: process.env.EMBEDDING_MODEL || 'voyage-3',
    embeddingDim: parseInt(process.env.EMBEDDING_DIM || '1024', 10),
    voyageApiKey: process.env.VOYAGE_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    vectorStore: (process.env.VECTOR_STORE as VectorStoreBackend) || VectorStoreBackend.JSONL,
    vectorStoreJsonlPath: path.isAbsolute(jsonlPath) ? jsonlPath : path.resolve(baseDir, jsonlPath),
    databaseUrl: process.env.DATABASE_URL || 'postgresql+psycopg://gss:gss@localhost:5432/gss_ao',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    llmModelLong: process.env.LLM_MODEL_LONG || 'claude-sonnet-4-6',
    llmModelUtility: process.env.LLM_MODEL_UTILITY || 'claude-haiku-4-5-20251001',
    s3EndpointUrl: process.env.S3_ENDPOINT_URL || '',
    s3Bucket: process.env.S3_BUCKET || 'gss-ao',
  };
}
