"""RAG — interface d'embeddings + implémentations.

En itération 1, le provider par défaut est `none` (dry-run) : le chunking et les
métadonnées sont produits SANS calculer d'embeddings (pas de clé API requise,
cf. DECISIONS.md D3). Les providers réels (Voyage / OpenAI / bge local) seront
branchés derrière la même interface `Embedder` — sans changer le code appelant.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from backend.core.config import EmbeddingProvider, Settings, get_settings


class Embedder(ABC):
    """Interface d'embeddings. `dim` est la dimension des vecteurs produits."""

    dim: int

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float] | None]:
        """Retourne un vecteur par texte (ou None si calcul différé)."""
        ...


class NullEmbedder(Embedder):
    """Mode dry-run : ne calcule rien, renvoie None pour chaque texte.

    La dimension reste connue (config) pour rester iso-schéma avec pgvector :
    on pourra recalculer les embeddings plus tard sans toucher au stockage.
    """

    def __init__(self, dim: int) -> None:
        self.dim = dim

    def embed(self, texts: list[str]) -> list[list[float] | None]:
        return [None] * len(texts)


class OpenAIEmbedder(Embedder):
    """Embeddings OpenAI (text-embedding-3-small par défaut, 1536 dims).

    Appels par lots (l'API accepte plusieurs inputs par requête). La clé est
    fournie explicitement (BYO-key) — jamais stockée côté serveur.
    """

    def __init__(self, api_key: str, *, model: str = "text-embedding-3-small",
                 dim: int = 1536, batch_size: int = 64) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("Clé API OpenAI requise pour OpenAIEmbedder.")
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key.strip())
        self.model = model
        self.dim = dim
        self.batch_size = batch_size

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start : start + self.batch_size]
            resp = self._client.embeddings.create(model=self.model, input=batch)
            vectors.extend([d.embedding for d in resp.data])
        return vectors


def get_embedder(settings: Settings | None = None, *, api_key: str | None = None) -> Embedder:
    """Fabrique l'Embedder selon la config.

    - `none` : NullEmbedder (dry-run, pas de clé requise).
    - `openai` : OpenAIEmbedder (clé via `api_key` ou settings.openai_api_key).
    Les autres providers (voyage/bge) ne sont pas implémentés.
    """
    settings = settings or get_settings()
    provider = settings.embedding_provider
    if provider is EmbeddingProvider.NONE:
        return NullEmbedder(dim=settings.embedding_dim)
    if provider is EmbeddingProvider.OPENAI:
        return OpenAIEmbedder(
            api_key=api_key or settings.openai_api_key,
            model=settings.embedding_model,
            dim=settings.embedding_dim,
        )
    raise NotImplementedError(
        f"Provider d'embeddings '{provider.value}' non implémenté "
        "(disponibles : none, openai)."
    )
