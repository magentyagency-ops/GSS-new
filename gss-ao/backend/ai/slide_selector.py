"""MODE B — recommandation des slides SLIDE REP AO à inclure (GPT-4o-mini).

Pour économiser les tokens, les 118 slides sont traitées par lots (batching) :
chaque appel classe 15 slides en keep / modify / discard avec une justification.
Le chapitre provient du catalogue statique (pas demandé au modèle).
"""

from __future__ import annotations

import json
from pathlib import Path

from backend.ai import client as ai_client
from backend.ai.prompts import SYSTEM_GSS

CATALOG_PATH = Path(__file__).parent / "slides_catalog.json"
BATCH_SIZE = 15
VALID_RECO = {"keep", "modify", "discard"}


def load_catalog() -> list[dict]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def _batch_prompt(
    batch: list[dict], cctp_extract: str, proposal_strengths: list[str], site_context: str
) -> str:
    items = "\n".join(
        f"- index {s['index']} | catégorie {s['category']} | {s['file_name']}" for s in batch
    )
    forces = "\n".join(f"- {p}" for p in proposal_strengths if p.strip()) or "(non précisé)"
    return (
        "Tu sélectionnes les slides du mémoire technique maître de GSS à inclure dans la "
        "réponse à CE marché. Pour chaque slide ci-dessous, indique si elle doit être :\n"
        '- "keep" : pertinente telle quelle,\n'
        '- "modify" : pertinente mais à personnaliser au contexte du marché,\n'
        '- "discard" : non pertinente pour ce marché.\n\n'
        f"CONTEXTE DU MARCHÉ (CCTP) :\n{cctp_extract.strip() or '(non fourni)'}\n\n"
        f"SITE :\n{site_context.strip() or '(non précisé)'}\n\n"
        f"ARGUMENTS DIFFÉRENCIANTS GSS :\n{forces}\n\n"
        f"SLIDES À CLASSER :\n{items}\n\n"
        'Réponds en JSON STRICT : {"slides":[{"index":<int>,"recommendation":'
        '"keep|modify|discard","justification":"<1 phrase>"}]}'
    )


def analyze_slides(
    api_key: str,
    *,
    cctp_extract: str,
    proposal_strengths: list[str],
    site_context: str,
) -> list[dict]:
    """Retourne la liste complète des slides enrichie de la recommandation IA."""
    catalog = load_catalog()
    by_index = {s["index"]: dict(s) for s in catalog}

    for start in range(0, len(catalog), BATCH_SIZE):
        batch = catalog[start : start + BATCH_SIZE]
        prompt = _batch_prompt(batch, cctp_extract, proposal_strengths, site_context)
        completion = ai_client.chat(
            api_key, SYSTEM_GSS, prompt, max_tokens=800, temperature=0.2, json_mode=True
        )
        try:
            parsed = json.loads(completion.text)
            for rec in parsed.get("slides", []):
                idx = rec.get("index")
                reco = rec.get("recommendation")
                if idx in by_index and reco in VALID_RECO:
                    by_index[idx]["recommendation"] = reco
                    by_index[idx]["justification"] = rec.get("justification", "")
        except (json.JSONDecodeError, AttributeError):
            continue  # lot illisible : les slides gardent le défaut ci-dessous

    # défaut pour les slides non classées
    result = []
    for s in by_index.values():
        s.setdefault("recommendation", "modify")
        s.setdefault("justification", "")
        result.append(s)
    return result
