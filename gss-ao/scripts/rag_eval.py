"""Évaluation comparative MOCK vs RAG réel sur 3 sections (Mode A).

Génère chaque section deux fois :
  - MOCK : contexte = chunks mock (état avant RAG) ;
  - RAG  : contexte = extraits réels récupérés dans sqlite-vec + citations.

Mesure : longueur (mots), nb de citations, nb de citations VALIDES (existant
réellement dans les sources), citations introuvables (hallucinations de source).
Sauve le détail dans data/output/rag_eval.json et imprime un tableau.

Pré-requis : index RAG construit (python -m backend.rag.indexer) + OPENAI_API_KEY.
Usage : python -m scripts.rag_eval
"""

from __future__ import annotations

import json
from pathlib import Path

from backend.ai import prompts
from backend.ai.client import chat
from backend.ai.routes_ai import _validate_citations
from backend.ai.sections import SECTIONS_BY_ID
from backend.core.config import get_settings
from backend.rag import retrieval

# 3 sections représentatives (humains / matériel / télésurveillance)
EVAL_SECTION_IDS = ["i_qualifications", "ii_rondes", "iv_report_alarmes"]

# Contexte "mock" minimal (état avant RAG) — 1 chunk générique par section.
MOCK_CHUNK = [{"categorie": "GSS", "source": "MOCK/contexte.pdf",
               "texte": "Contexte générique GSS (sécurité privée)."}]


def _metrics(text: str, available: set[str]) -> dict:
    import re

    cites = re.findall(r"\(source\s*:\s*([^)]+?\.pdf)\)", text, re.IGNORECASE)
    unknown = _validate_citations(text, available)
    return {
        "words": len(text.split()),
        "citations": len(cites),
        "citations_valid": len(cites) - len(unknown),
        "citations_unknown": len(unknown),
    }


def run() -> None:
    settings = get_settings()
    key = settings.openai_api_key
    if not key:
        raise SystemExit("OPENAI_API_KEY manquante (.env).")
    if not retrieval.index_exists():
        raise SystemExit("Index RAG absent. Lancez : python -m backend.rag.indexer")

    results = []
    for sid in EVAL_SECTION_IDS:
        spec = SECTIONS_BY_ID[sid]

        # --- MOCK ---
        mock_prompt = prompts.build_user_prompt_mode_a(
            template_question=spec.question, cctp_extract="",
            rag_chunks=MOCK_CHUNK, target_words=spec.target, points=spec.points,
        )
        mock = chat(key, prompts.SYSTEM_GSS, mock_prompt, max_tokens=800)
        mock_avail = {c["source"].lower() for c in MOCK_CHUNK}

        # --- RAG ---
        hits = retrieval.search(spec.question, top_k=5, api_key=key)
        rag_chunks = [{"categorie": h.dossier, "source": h.citation(), "texte": h.texte}
                      for h in hits]
        rag_avail = {h.citation().lower() for h in hits}
        rag_prompt = prompts.build_user_prompt_mode_a(
            template_question=spec.question, cctp_extract="",
            rag_chunks=rag_chunks, target_words=spec.target, points=spec.points,
        )
        rag = chat(key, prompts.SYSTEM_GSS, rag_prompt, max_tokens=800)

        results.append({
            "section": sid,
            "mock": {"text": mock.text, **_metrics(mock.text, mock_avail)},
            "rag": {"text": rag.text, "sources": sorted(rag_avail),
                    **_metrics(rag.text, rag_avail)},
        })

    out = Path("data/output/rag_eval.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{'section':22} | {'mots(mock/rag)':16} | {'cit. valides rag':16} | cit. fausses")
    print("-" * 78)
    for r in results:
        print(
            f"{r['section']:22} | {r['mock']['words']:>5} / {r['rag']['words']:<7} | "
            f"{r['rag']['citations_valid']:>14}   | {r['rag']['citations_unknown']}"
        )
    print(f"\nDétail complet : {out}")


if __name__ == "__main__":
    run()
