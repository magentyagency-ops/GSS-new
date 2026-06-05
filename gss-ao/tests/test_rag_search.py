"""Tests RAG retrieval/endpoints — hors-ligne (sans appel OpenAI réel)."""

import importlib.util

import pytest

_HAS_FASTAPI = importlib.util.find_spec("fastapi") is not None
_HAS_SQLITE_VEC = importlib.util.find_spec("sqlite_vec") is not None

pytestmark = pytest.mark.skipif(
    not (_HAS_FASTAPI and _HAS_SQLITE_VEC), reason="fastapi/sqlite-vec requis"
)


def test_validate_citations_flags_unknown():
    from backend.ai.routes_ai import _validate_citations

    available = {"formation/formation agent ssiap1 3.pdf"}
    text = (
        "Agents SSIAP1 (source: FORMATION/FORMATION AGENT SSIAP1 3.pdf) "
        "et APS (source: INVENTE/faux.pdf)."
    )
    unknown = _validate_citations(text, available)
    assert unknown == ["invente/faux.pdf"]


def test_validate_citations_empty_when_all_known():
    from backend.ai.routes_ai import _validate_citations

    assert _validate_citations("Texte sans citation.", {"a/b.pdf"}) == []


def test_rag_context_fallback_without_index(tmp_path, monkeypatch):
    """Sans index, _rag_context retombe proprement sur (vide, vide, False)."""
    from backend.ai import routes_ai

    monkeypatch.setattr(routes_ai.retrieval, "index_exists", lambda *a, **k: False)
    chunks, citations, used, sources = routes_ai._rag_context("ma requête", "sk-test")
    assert chunks == [] and citations == set() and used is False and sources == []


def test_rag_search_endpoint_409_without_index(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend.ai import routes_ai
    from backend.main import app

    monkeypatch.setattr(routes_ai.retrieval, "index_exists", lambda *a, **k: False)
    client = TestClient(app)
    r = client.post("/api/rag/search", json={"query": "SSIAP", "top_k": 3})
    assert r.status_code == 409
    assert "indexer" in r.json()["error"].lower()


def test_generate_section_without_key_returns_error(monkeypatch):
    """Sans clé : pas de RAG (index absent) puis erreur OpenAI propre (pas un 500)."""
    from fastapi.testclient import TestClient

    from backend.ai import routes_ai
    from backend.main import app

    monkeypatch.setattr(routes_ai.retrieval, "index_exists", lambda *a, **k: False)
    client = TestClient(app)
    r = client.post(
        "/api/rag/search".replace("/rag/search", "/generate-section"),
        json={"api_key": "", "section_id": "i_qualifications"},
    )
    assert r.status_code in (400, 401)
    assert "error" in r.json()


def test_index_exists_false_for_missing_db(tmp_path):
    from backend.core.config import Settings, VectorStoreBackend
    from backend.rag.retrieval import index_exists

    s = Settings(
        _env_file=None,
        vector_store=VectorStoreBackend.SQLITE_VEC,
        rag_db_path=tmp_path / "absent.db",
        embedding_dim=8,
    )
    assert index_exists(s) is False
