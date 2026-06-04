"""Construction des prompts de génération de sections (Mode A et Mode B)."""

from __future__ import annotations

SYSTEM_GSS = (
    "Tu es un expert en réponse aux appels d'offres de sécurité privée pour GSS, "
    "société française de sécurité (gardiennage, télésurveillance, contrôle d'accès). "
    "Tu rédiges de manière précise, professionnelle et sourcée, à la première personne "
    "du pluriel (la voix de GSS). Tu t'appuies STRICTEMENT sur les éléments fournis "
    "(exigences du CCTP et contenus de la base GSS) sans inventer de chiffres non fournis. "
    "Tu produis un texte prêt à insérer dans un mémoire technique, sans titre ni préambule, "
    "sans formule de politesse, en français."
)


def _format_chunks(rag_chunks: list[dict]) -> str:
    if not rag_chunks:
        return "(aucun extrait de base fourni)"
    lines = []
    for c in rag_chunks:
        cat = c.get("categorie", "?")
        src = c.get("source", "?")
        txt = (c.get("texte") or "").strip()
        lines.append(f"- [{cat}] {src} : {txt}")
    return "\n".join(lines)


def build_user_prompt_mode_a(
    *,
    template_question: str,
    cctp_extract: str,
    rag_chunks: list[dict],
    target_words: str,
    points: int,
) -> str:
    """Prompt utilisateur pour une section en MODE A (question imposée)."""
    return (
        f"QUESTION IMPOSÉE PAR L'ACHETEUR (à laquelle répondre directement) :\n"
        f"{template_question}\n\n"
        f"EXTRAIT DU CCTP (exigences techniques du marché) :\n"
        f"{cctp_extract.strip() or '(non fourni)'}\n\n"
        f"CONTENUS RÉUTILISABLES DE LA BASE GSS (SLIDE REP AO) :\n"
        f"{_format_chunks(rag_chunks)}\n\n"
        f"CONSIGNES DE FORMAT :\n"
        f"- Réponds uniquement à la question imposée ci-dessus.\n"
        f"- Longueur cible : {target_words} mots (critère noté sur {points} points).\n"
        f"- Texte continu, professionnel, personnalisé au contexte de l'Université de "
        f"Rouen Normandie. Pas de titre, pas de liste à puces sauf si pertinent.\n"
    )


def build_user_prompt_mode_b(
    *,
    section_name: str,
    cctp_extract: str,
    selected_slides: list[dict],
    target_words: str,
) -> str:
    """Prompt utilisateur pour une section en MODE B (réponse libre, slides GSS)."""
    return (
        f"Rédige la section « {section_name} » du mémoire technique GSS pour ce marché, "
        f"en t'appuyant sur les slides GSS sélectionnées ci-dessous. Style professionnel, "
        f"voix de GSS, personnalisé au contexte du marché.\n\n"
        f"EXTRAIT DU CCTP :\n{cctp_extract.strip() or '(non fourni)'}\n\n"
        f"SLIDES GSS SÉLECTIONNÉES :\n{_format_chunks(selected_slides)}\n\n"
        f"Longueur cible : {target_words} mots. Pas de titre ni préambule.\n"
    )
