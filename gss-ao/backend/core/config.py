"""Configuration centralisée (pydantic-settings).

Toutes les variables proviennent de l'environnement ou d'un fichier `.env`
(cf. `.env.example`). Aucune valeur secrète n'est codée en dur.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EmbeddingProvider(str, Enum):
    VOYAGE = "voyage"
    OPENAI = "openai"
    BGE_LOCAL = "bge_local"
    NONE = "none"  # dry-run : pas de calcul réel d'embeddings


class VectorStoreBackend(str, Enum):
    JSONL = "jsonl"  # fallback local sans Docker
    SQLITE_VEC = "sqlite_vec"  # RAG réel local (fichier .db)
    PGVECTOR = "pgvector"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- Corpus -------------------------------------------------------------
    corpus_dce_dir: Path = Field(default=Path("../Cas-Univ-Rouen-MP2026-08"))
    corpus_slide_rep_ao_dir: Path = Field(default=Path("../SLIDE REP AO"))

    # --- Conversion .doc ----------------------------------------------------
    # Vide => auto-détection (voir backend/ingestion/doc_converter.py).
    soffice_bin: str = ""

    # --- OCR (fallback optionnel) ------------------------------------------
    ocr_enabled: bool = False
    tesseract_bin: str = ""
    ocr_lang: str = "fra"

    # --- Embeddings ---------------------------------------------------------
    # RAG réel : OpenAI text-embedding-3-small (1536 dims).
    embedding_provider: EmbeddingProvider = EmbeddingProvider.OPENAI
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    voyage_api_key: str = ""
    openai_api_key: str = ""

    # --- Vector store -------------------------------------------------------
    vector_store: VectorStoreBackend = VectorStoreBackend.SQLITE_VEC
    vector_store_jsonl_path: Path = Field(
        default=Path("data/output/slide_rep_ao_chunks.jsonl")
    )
    rag_db_path: Path = Field(default=Path("data/rag/slide_rep_ao.db"))
    database_url: str = "postgresql+psycopg://gss:gss@localhost:5432/gss_ao"

    # --- LLM (non appelé en itération 1) -----------------------------------
    anthropic_api_key: str = ""
    llm_model_long: str = "claude-sonnet-4-6"
    llm_model_utility: str = "claude-haiku-4-5-20251001"

    # --- Stockage objets ----------------------------------------------------
    s3_endpoint_url: str = ""
    s3_bucket: str = "gss-ao"


def get_settings() -> Settings:
    """Retourne les settings. Fonction (pas singleton global) pour faciliter
    l'override dans les tests."""
    return Settings()
