"""Endpoints FastAPI de génération IA (Module C / écran 5).

Montés à côté des routes existantes (aucune route de l'itération 1 modifiée).
La clé OpenAI est fournie par requête (BYO-key).
"""

from __future__ import annotations

import re
from datetime import UTC

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.ai import client as ai_client
from backend.ai import prompts
from backend.ai.memoire_filler import fill_template
from backend.ai.memoire_filler_b import build_memoire_b
from backend.ai.sections import SECTIONS, SECTIONS_BY_ID
from backend.ai.sections_b import SECTIONS_B
from backend.ai.slide_selector import analyze_slides
from backend.rag import retrieval

# Citation au format (source: DOSSIER/fichier.pdf)
_CITATION_RE = re.compile(r"\(source\s*:\s*([^)]+?\.pdf)\)", re.IGNORECASE)


def _rag_context(query: str, api_key: str, *, top_k: int = 5):
    """Récupère des extraits RAG sourcés pour `query`.

    Retourne (context_chunks, citations_disponibles, rag_used, sources_struct).
    `sources_struct` = [{dossier, fichier, page, citation, texte}]. Si l'index
    n'existe pas ou en cas d'erreur → ([], set(), False, []) (fallback).
    """
    try:
        if not retrieval.index_exists():
            return [], set(), False, []
        hits = retrieval.search(query, top_k=top_k, api_key=api_key)
        chunks = [{"categorie": h.dossier, "source": h.citation(), "texte": h.texte} for h in hits]
        citations = {h.citation().lower() for h in hits}
        sources = [
            {"dossier": h.dossier, "fichier": h.fichier, "page": h.page,
             "citation": h.citation(), "texte": h.texte}
            for h in hits
        ]
        return chunks, citations, True, sources
    except Exception:  # noqa: BLE001 - le RAG est best-effort, jamais bloquant
        return [], set(), False, []


def _validate_citations(text: str, available: set[str]) -> list[str]:
    """Retourne les citations présentes dans le texte mais ABSENTES des sources
    réellement fournies (signalées sans modifier le texte)."""
    cited = {m.strip().lower() for m in _CITATION_RE.findall(text)}
    return sorted(c for c in cited if c not in available)


router = APIRouter(prefix="/api", tags=["ai"])

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


# --------------------------------------------------------------------------- #
class RagChunk(BaseModel):
    categorie: str = ""
    source: str = ""
    texte: str = ""


class GenerateSectionRequest(BaseModel):
    api_key: str
    section_id: str
    cctp_extract: str = ""
    rag_chunks: list[RagChunk] = Field(default_factory=list)
    template_question: str | None = None
    mode: str = "A"  # "A" imposé | "B" libre (Phase 2)
    selected_slides: list[RagChunk] = Field(default_factory=list)


class GenerateSectionResponse(BaseModel):
    generated_text: str
    model: str
    tokens_used: int
    rag_used: bool = False
    sources: list[dict] = Field(default_factory=list)
    citation_warnings: list[str] = Field(default_factory=list)


class RagSearchRequest(BaseModel):
    query: str
    filtre_thematique: str | None = None
    top_k: int = 5
    api_key: str | None = None  # sinon clé serveur (.env)


class TestKeyRequest(BaseModel):
    api_key: str


class SlideRef(BaseModel):
    index: int | None = None
    file_name: str = ""
    category: str = ""
    chapter: str = ""


class ExportDocxRequest(BaseModel):
    sections: dict[str, str] = Field(default_factory=dict)
    mode: str = "A"
    identite: dict | None = None
    signataire: str | None = None
    date_signature: str | None = None
    # Mode B
    selected_slides: list[SlideRef] = Field(default_factory=list)
    projet: str = "Mémoire technique"
    acheteur: str = ""


class AnalyzeSlidesRequest(BaseModel):
    api_key: str
    cctp_extract: str = ""
    proposal_strengths: list[str] = Field(default_factory=list)
    site_context: str = ""


# --------------------------------------------------------------------------- #
@router.get("/ai/sections")
def list_sections() -> list[dict]:
    """Catalogue des sections Mode A (consommé par l'écran 5)."""
    return [
        {"id": s.id, "chapter": s.chapter, "points": s.points, "question": s.question}
        for s in SECTIONS
    ]


@router.post("/test-key")
def test_key(req: TestKeyRequest) -> JSONResponse:
    try:
        valid = ai_client.test_api_key(req.api_key)
        return JSONResponse({"valid": valid})
    except ai_client.AIError as exc:
        return JSONResponse({"valid": False, "error": str(exc)}, status_code=exc.status_code)


@router.post("/generate-section", response_model=GenerateSectionResponse)
def generate_section(req: GenerateSectionRequest) -> JSONResponse:
    spec = SECTIONS_BY_ID.get(req.section_id)
    target = spec.target if spec else "150-300"
    points = spec.points if spec else 10

    # --- RAG réel : récupère des extraits sourcés pour l'intitulé de la section ---
    query = req.template_question or (spec.question if spec else req.section_id)
    rag_chunks, citations_available, rag_used, sources_out = _rag_context(query, req.api_key)

    def _sources_from(chunks: list[dict]) -> list[dict]:
        return [
            {"dossier": c.get("categorie", ""), "fichier": c.get("source", ""),
             "page": None, "citation": c.get("source", ""), "texte": c.get("texte", "")}
            for c in chunks if c.get("source")
        ]

    if req.mode == "B":
        # Mode B : contexte = RAG si dispo, sinon slides sélectionnées (frontend)
        slides = rag_chunks or [s.model_dump() for s in req.selected_slides]
        if not rag_used:
            citations_available = {
                (s.get("source") or "").lower() for s in slides if s.get("source")
            }
            sources_out = _sources_from(slides)
        user = prompts.build_user_prompt_mode_b(
            section_name=req.template_question or req.section_id,
            cctp_extract=req.cctp_extract,
            selected_slides=slides,
            target_words=target,
        )
    else:
        question = req.template_question or (spec.question if spec else "")
        if not question:
            return JSONResponse(
                {"error": f"section_id inconnu et template_question absent : {req.section_id}"},
                status_code=400,
            )
        # Mode A : contexte = RAG si dispo, sinon chunks mock fournis par le frontend
        chunks = rag_chunks or [c.model_dump() for c in req.rag_chunks]
        if not rag_used:
            citations_available = {
                (c.get("source") or "").lower() for c in chunks if c.get("source")
            }
            sources_out = _sources_from(chunks)
        user = prompts.build_user_prompt_mode_a(
            template_question=question,
            cctp_extract=req.cctp_extract,
            rag_chunks=chunks,
            target_words=target,
            points=points,
        )

    try:
        completion = ai_client.chat(req.api_key, prompts.SYSTEM_GSS, user, max_tokens=800)
    except ai_client.AIError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status_code)

    # Validation des citations : signale celles introuvables (sans modifier le texte)
    unknown = _validate_citations(completion.text, citations_available)

    return JSONResponse(
        {
            "generated_text": completion.text,
            "model": completion.model,
            "tokens_used": completion.tokens_used,
            "rag_used": rag_used,
            "sources": sources_out,
            "citation_warnings": unknown,
        }
    )


@router.get("/ai/sections-b")
def list_sections_b() -> list[dict]:
    """Catalogue des sections génériques Mode B (réponse libre)."""
    return [{"id": s.id, "chapter": s.chapter, "title": s.title} for s in SECTIONS_B]


@router.get("/rag/status")
def rag_status() -> JSONResponse:
    """État de l'index RAG (pour le badge écran 5 + stats Paramètres)."""
    from datetime import datetime

    from backend.core.config import get_settings

    settings = get_settings()
    ready = retrieval.index_exists()
    chunks_count = 0
    last_indexed_at = None
    if ready:
        try:
            from backend.rag.vector_store import SqliteVecStore

            store = SqliteVecStore(settings.rag_db_path, settings.embedding_dim)
            chunks_count = store.count()
            ts = settings.rag_db_path.stat().st_mtime
            last_indexed_at = datetime.fromtimestamp(ts, tz=UTC).isoformat()
        except Exception:  # noqa: BLE001
            ready = False
    return JSONResponse(
        {
            "ready": ready,
            "chunks_count": chunks_count,
            "last_indexed_at": last_indexed_at,
            "embedder": f"openai/{settings.embedding_model}",
            "store": "sqlite-vec",
        }
    )


@router.post("/rag/search")
def rag_search(req: RagSearchRequest) -> JSONResponse:
    """Recherche RAG hybride : filtre thématique optionnel + similarité vectorielle."""
    if not retrieval.index_exists():
        return JSONResponse(
            {"error": "Index RAG absent. Lancez : python -m backend.rag.indexer"},
            status_code=409,
        )
    try:
        hits = retrieval.search(
            req.query,
            filtre_thematique=req.filtre_thematique,
            top_k=req.top_k,
            api_key=req.api_key,
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except ai_client.AIError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status_code)
    return JSONResponse({"results": [h.as_dict() for h in hits], "count": len(hits)})


@router.post("/analyze-slides")
def analyze_slides_endpoint(req: AnalyzeSlidesRequest) -> JSONResponse:
    try:
        slides = analyze_slides(
            req.api_key,
            cctp_extract=req.cctp_extract,
            proposal_strengths=req.proposal_strengths,
            site_context=req.site_context,
        )
    except ai_client.AIError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status_code)
    return JSONResponse({"slides": slides, "total": len(slides)})


@router.post("/export-docx")
def export_docx(req: ExportDocxRequest) -> Response:
    if req.mode == "B":
        docx_bytes, report = build_memoire_b(
            req.sections,
            selected_slides=[s.model_dump() for s in req.selected_slides],
            projet=req.projet,
            acheteur=req.acheteur,
            signataire=req.signataire,
            date_signature=req.date_signature,
        )
        filename = "Memoire_Technique_GSS_reponse_libre.docx"
    else:
        try:
            docx_bytes, report = fill_template(
                req.sections,
                identite=req.identite,
                signataire=req.signataire,
                date_signature=req.date_signature,
            )
        except FileNotFoundError as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)
        filename = "Memoire_Technique_GSS_Univ_Rouen_MP2026-08.docx"

    fill_report = f"filled={len(report['filled'])};missing={','.join(report['missing'])}"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Fill-Report": fill_report,
    }
    return Response(content=docx_bytes, media_type=DOCX_MIME, headers=headers)
