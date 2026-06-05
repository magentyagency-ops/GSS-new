"""Tests de l'ingestion RAG : chunking, store JSONL, iso-schéma, embeddings."""

import os
from pathlib import Path

import pytest

from backend.core.config import Settings, VectorStoreBackend
from backend.rag.chunking import (
    chunk_pdf,
    make_chunk_id,
    normalize_text,
    split_text,
)
from backend.rag.embeddings import NullEmbedder, get_embedder
from backend.rag.ingestion import ingest_slide_rep_ao, iter_pdfs
from backend.rag.vector_store import JsonlVectorStore, PgVectorStore, get_vector_store
from backend.schemas.rag import Chunk, ChunkMetadata

_CORPUS = Path(os.environ.get("CORPUS_SLIDE_REP_AO_DIR", "../SLIDE REP AO"))


# --- chunking (unités) -------------------------------------------------------

def test_make_chunk_id_deterministic():
    a = make_chunk_id("PROCEDURE/x.pdf", 3)
    b = make_chunk_id("PROCEDURE/x.pdf", 3)
    c = make_chunk_id("PROCEDURE/x.pdf", 4)
    assert a == b and a != c


def test_normalize_text():
    assert normalize_text("a\xa0 b\t\tc\n\n\n\nd") == "a b c\n\nd"


def test_split_text_short_returns_single():
    assert split_text("court") == ["court"]


def test_split_text_respects_max_chars():
    text = "\n\n".join(f"Paragraphe numéro {i} avec du contenu." for i in range(50))
    chunks = split_text(text, max_chars=200, overlap=20)
    assert len(chunks) > 1
    assert all(len(c) <= 200 + 20 for c in chunks)


# --- vector store JSONL ------------------------------------------------------

def _chunk(cid: str, idx: int) -> Chunk:
    return Chunk(
        chunk_id=cid,
        text=f"texte {idx}",
        metadata=ChunkMetadata(
            categorie="PROCEDURE",
            source_file="x.pdf",
            source_path="PROCEDURE/x.pdf",
            page=1,
            chunk_index=idx,
        ),
    )


def test_jsonl_store_upsert_idempotent(tmp_path):
    store = JsonlVectorStore(tmp_path / "chunks.jsonl")
    chunks = [_chunk("a", 0), _chunk("b", 1)]
    store.upsert(chunks)
    store.upsert(chunks)  # ré-upsert : pas de doublon
    assert store.count() == 2


def test_jsonl_roundtrip_preserves_schema(tmp_path):
    store = JsonlVectorStore(tmp_path / "c.jsonl")
    store.upsert([_chunk("a", 0)])
    line = (tmp_path / "c.jsonl").read_text().splitlines()[0]
    back = Chunk.model_validate_json(line)
    assert back.chunk_id == "a"
    assert back.metadata.categorie == "PROCEDURE"
    assert back.embedding is None


def test_factory_returns_jsonl_by_default(tmp_path):
    s = Settings(
        _env_file=None,
        vector_store=VectorStoreBackend.JSONL,
        vector_store_jsonl_path=tmp_path / "x.jsonl",
    )
    assert isinstance(get_vector_store(s), JsonlVectorStore)


def test_factory_returns_sqlite_vec(tmp_path):
    s = Settings(
        _env_file=None,
        vector_store=VectorStoreBackend.SQLITE_VEC,
        rag_db_path=tmp_path / "test.db",
        embedding_dim=3,
    )
    from backend.rag.vector_store import SqliteVecStore
    store = get_vector_store(s)
    assert isinstance(store, SqliteVecStore)


def test_sqlite_vec_store_upsert_and_search(tmp_path):
    from backend.rag.vector_store import SqliteVecStore
    db_path = tmp_path / "test.db"
    store = SqliteVecStore(db_path, dim=3)
    
    # Check initial count
    assert store.count() == 0
    
    # Create chunks with embeddings
    c1 = _chunk("chunk_1", 1)
    c1.embedding = [1.0, 0.0, 0.0]
    
    c2 = _chunk("chunk_2", 2)
    c2.embedding = [0.0, 1.0, 0.0]
    
    # Upsert
    store.upsert([c1, c2])
    assert store.count() == 2
    
    # Search
    results = store.search_hybrid([1.0, 0.0, 0.0], top_k=1)
    assert len(results) == 1
    assert results[0]["chunk_id"] == "chunk_1"
    
    # Search with category filter
    results = store.search_hybrid([0.0, 1.0, 0.0], top_k=1, dossier="PROCEDURE")
    assert len(results) == 1
    assert results[0]["chunk_id"] == "chunk_2"
    
    # Search with non-matching filter
    results = store.search_hybrid([0.0, 1.0, 0.0], top_k=1, dossier="NON_EXISTENT")
    assert len(results) == 0

    # Reset
    store.reset()
    assert store.count() == 0



# --- iso-schéma JSONL <-> pgvector (sans base) -------------------------------

def test_pgvector_row_matches_table_columns():
    """Garantit DECISIONS.md D2 : aucun refactor pour passer JSONL -> pgvector."""
    from backend.db import models

    # instancier sans connexion (create_engine est paresseux)
    store = PgVectorStore("postgresql+psycopg://u:p@localhost:5432/db")
    row = store._to_row(_chunk("a", 0))
    table_cols = set(models.RagChunk.__table__.columns.keys())
    assert set(row.keys()) == table_cols


# --- embeddings --------------------------------------------------------------

def test_null_embedder_returns_none():
    emb = NullEmbedder(dim=1024)
    assert emb.embed(["a", "b"]) == [None, None]
    assert emb.dim == 1024


def test_get_embedder_other_provider_raises():
    s = Settings(_env_file=None, embedding_provider="voyage")
    with pytest.raises(NotImplementedError):
        get_embedder(s)


def test_openai_embedder_initialization():
    from backend.rag.embeddings import OpenAIEmbedder
    with pytest.raises(ValueError, match="Clé API OpenAI requise"):
        OpenAIEmbedder(api_key="")

    emb = OpenAIEmbedder(api_key="test-key", model="text-embedding-3-small", dim=1536)
    assert emb.model == "text-embedding-3-small"
    assert emb.dim == 1536



# --- intégration corpus ------------------------------------------------------

@pytest.mark.requires_corpus
def test_chunk_pdf_real():
    pdf = next(_CORPUS.rglob("*.pdf"), None)
    if pdf is None:
        pytest.skip(f"Corpus absent : {_CORPUS}")
    rel = str(pdf.relative_to(_CORPUS))
    chunks = chunk_pdf(pdf, categorie=rel.split("/")[0], source_path=rel)
    assert chunks
    assert all(c.metadata.page is not None for c in chunks)
    assert all(c.embedding is None for c in chunks)  # dry-run


@pytest.mark.requires_corpus
def test_ingest_subset(tmp_path):
    if not _CORPUS.exists():
        pytest.skip(f"Corpus absent : {_CORPUS}")
    # ingère seulement la 1re catégorie pour rester rapide
    first_cat = next(p for p, _, _ in iter_pdfs(_CORPUS)).relative_to(_CORPUS).parts[0]
    src = _CORPUS / first_cat
    store = JsonlVectorStore(tmp_path / "out.jsonl")
    stats = ingest_slide_rep_ao(src, store, NullEmbedder(dim=1024))
    assert stats.files >= 1
    assert stats.chunks >= 1
    assert stats.embedded == 0
    assert store.count() == stats.chunks
