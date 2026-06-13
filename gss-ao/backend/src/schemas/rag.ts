export interface ChunkMetadata {
  categorie: string;
  source_file: string;
  source_path: string;
  page: number | null;
  chunk_index: number;
  keywords: string[];
}

export interface Chunk {
  chunk_id: string;
  text: string;
  metadata: ChunkMetadata;
  embedding: number[] | null;
}
