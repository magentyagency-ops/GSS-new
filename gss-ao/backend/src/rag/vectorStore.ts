import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { getSettings, VectorStoreBackend } from '../core/config';
import { Chunk } from '../schemas/rag';

export interface VectorStore {
  upsert(chunks: Chunk[]): Promise<number>;
  count(): Promise<number>;
}

export class JsonlVectorStore implements VectorStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  private load(): Record<string, Chunk> {
    const existing: Record<string, Chunk> = {};
    if (fs.existsSync(this.filePath)) {
      const content = fs.readFileSync(this.filePath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            const chunk = JSON.parse(trimmed) as Chunk;
            existing[chunk.chunk_id] = chunk;
          } catch (e) {}
        }
      }
    }
    return existing;
  }

  async upsert(chunks: Chunk[]): Promise<number> {
    const merged = this.load();
    for (const c of chunks) {
      merged[c.chunk_id] = c;
    }

    const parentDir = path.dirname(this.filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const lines = Object.values(merged).map(c => JSON.stringify(c)).join('\n') + '\n';
    fs.writeFileSync(this.filePath, lines, 'utf8');
    return chunks.length;
  }

  async count(): Promise<number> {
    return Object.keys(this.load()).length;
  }
}

export class PgVectorStore implements VectorStore {
  private databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  private async getClient(): Promise<Client> {
    // Replace postgresql+psycopg:// with postgres:// for pg driver compatibility
    const connectionString = this.databaseUrl.replace(/^postgresql\+psycopg:\/\//, 'postgresql://');
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  }

  async upsert(chunks: Chunk[]): Promise<number> {
    const client = await this.getClient();
    try {
      for (const c of chunks) {
        const extra = { keywords: c.metadata.keywords };
        const embeddingStr = c.embedding ? `[${c.embedding.join(',')}]` : null;

        const query = `
          INSERT INTO rag_chunk (chunk_id, text, categorie, source_file, source_path, page, chunk_index, extra, embedding)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (chunk_id) DO UPDATE SET
            text = EXCLUDED.text,
            categorie = EXCLUDED.categorie,
            source_file = EXCLUDED.source_file,
            source_path = EXCLUDED.source_path,
            page = EXCLUDED.page,
            chunk_index = EXCLUDED.chunk_index,
            extra = EXCLUDED.extra,
            embedding = EXCLUDED.embedding
        `;

        await client.query(query, [
          c.chunk_id,
          c.text,
          c.metadata.categorie,
          c.metadata.source_file,
          c.metadata.source_path,
          c.metadata.page,
          c.metadata.chunk_index,
          JSON.stringify(extra),
          embeddingStr,
        ]);
      }
      return chunks.length;
    } finally {
      await client.end();
    }
  }

  async count(): Promise<number> {
    const client = await this.getClient();
    try {
      const res = await client.query('SELECT COUNT(*)::int as count FROM rag_chunk');
      return res.rows[0].count;
    } finally {
      await client.end();
    }
  }
}

export function getVectorStore(): VectorStore {
  const settings = getSettings();
  if (settings.vectorStore === VectorStoreBackend.JSONL) {
    return new JsonlVectorStore(settings.vectorStoreJsonlPath);
  }
  if (settings.vectorStore === VectorStoreBackend.PGVECTOR) {
    return new PgVectorStore(settings.databaseUrl);
  }
  throw new Error(`Backend vector store inconnu : ${settings.vectorStore}`);
}
