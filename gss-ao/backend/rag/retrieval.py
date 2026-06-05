"""RAG — récupération (retrieval hybride : filtre thématique + similarité).

Embed la requête (OpenAI) puis interroge sqlite-vec. Retourne des extraits
sourcés (dossier, fichier, page) prêts à citer dans la génération.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.config import Settings, get_settings
from backend.rag.embeddings import OpenAIEmbedder
from backend.rag.vector_store import SqliteVecStore


@dataclass
class RetrievedChunk:
    chunk_id: str
    dossier: str
    fichier: str
    page: int
    texte: str
    distance: float

    def citation(self) -> str:
        return f"{self.dossier}/{self.fichier}"

    def as_dict(self) -> dict:
        return {
            "chunk_id": self.chunk_id,
            "dossier": self.dossier,
            "fichier": self.fichier,
            "page": self.page,
            "texte": self.texte,
            "distance": round(self.distance, 4),
            "citation": self.citation(),
        }


def search(
    query: str,
    *,
    filtre_thematique: str | None = None,
    top_k: int = 5,
    api_key: str | None = None,
    settings: Settings | None = None,
) -> list[RetrievedChunk]:
    """Recherche hybride. Retourne les top_k extraits les plus pertinents."""
    settings = settings or get_settings()
    key = api_key or settings.openai_api_key
    if not key:
        raise ValueError("Clé OpenAI requise pour la recherche RAG (embedding de la requête).")

    embedder = OpenAIEmbedder(
        api_key=key, model=settings.embedding_model, dim=settings.embedding_dim
    )
    query_vec = embedder.embed([query])[0]

    store = SqliteVecStore(settings.rag_db_path, settings.embedding_dim)
    rows = store.search_hybrid(query_vec, top_k=top_k, dossier=filtre_thematique)
    return [
        RetrievedChunk(
            chunk_id=r["chunk_id"], dossier=r["dossier"], fichier=r["fichier"],
            page=r["page"], texte=r["texte"], distance=r["distance"],
        )
        for r in rows
    ]


def index_exists(settings: Settings | None = None) -> bool:
    """True si l'index sqlite-vec contient des chunks (RAG prêt)."""
    settings = settings or get_settings()
    if not settings.rag_db_path.exists():
        return False
    try:
        store = SqliteVecStore(settings.rag_db_path, settings.embedding_dim)
        return store.count() > 0
    except Exception:  # noqa: BLE001
        return False
