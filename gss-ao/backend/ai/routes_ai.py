"""Endpoints FastAPI de génération IA (Module C / écran 5).

Montés à côté des routes existantes (aucune route de l'itération 1 modifiée).
La clé OpenAI est fournie par requête (BYO-key).
"""

from __future__ import annotations

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

    if req.mode == "B":
        user = prompts.build_user_prompt_mode_b(
            section_name=req.template_question or req.section_id,
            cctp_extract=req.cctp_extract,
            selected_slides=[s.model_dump() for s in req.selected_slides],
            target_words=target,
        )
    else:
        question = req.template_question or (spec.question if spec else "")
        if not question:
            return JSONResponse(
                {"error": f"section_id inconnu et template_question absent : {req.section_id}"},
                status_code=400,
            )
        user = prompts.build_user_prompt_mode_a(
            template_question=question,
            cctp_extract=req.cctp_extract,
            rag_chunks=[c.model_dump() for c in req.rag_chunks],
            target_words=target,
            points=points,
        )

    try:
        completion = ai_client.chat(req.api_key, prompts.SYSTEM_GSS, user, max_tokens=800)
    except ai_client.AIError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status_code)

    return JSONResponse(
        {
            "generated_text": completion.text,
            "model": completion.model,
            "tokens_used": completion.tokens_used,
        }
    )


@router.get("/ai/sections-b")
def list_sections_b() -> list[dict]:
    """Catalogue des sections génériques Mode B (réponse libre)."""
    return [{"id": s.id, "chapter": s.chapter, "title": s.title} for s in SECTIONS_B]


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
