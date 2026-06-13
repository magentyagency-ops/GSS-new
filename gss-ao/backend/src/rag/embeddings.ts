import { getSettings, EmbeddingProvider } from '../core/config';

export interface Embedder {
  dim: number;
  embed(texts: string[]): Promise<Array<number[] | null>>;
}

export class NullEmbedder implements Embedder {
  dim: number;

  constructor(dim: number) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    return texts.map(() => null);
  }
}

export function getEmbedder(): Embedder {
  const settings = getSettings();
  const provider = settings.embeddingProvider;

  if (provider === EmbeddingProvider.NONE) {
    return new NullEmbedder(settings.embeddingDim);
  }

  throw new Error(
    `Provider d'embeddings '${provider}' non implémenté en itération 1 ` +
    `(seul 'none'/dry-run est disponible).`
  );
}
