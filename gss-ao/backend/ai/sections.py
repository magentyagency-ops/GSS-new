"""Catalogue des sections du mémoire technique — MODE A (template imposé Univ Rouen).

Chaque entrée décrit une zone de réponse rédigée (prose) du template
`5-Mémoire Technique - lots 1-2-3.docx` :
  - id        : identifiant stable (utilisé par le frontend + localStorage)
  - chapter   : I / II / III / IV
  - points    : pondération (oriente la longueur cible)
  - label     : sous-chaîne servant à localiser le paragraphe-question dans le .docx
  - inline    : True si la zone de pointillés est SUR la même ligne que l'intitulé
  - question  : la question imposée, transmise telle quelle au modèle
  - target    : fourchette de longueur cible (mots)

Les zones purement factuelles (effectifs, SIRET, n° de certification, tableaux de
délais, cases à cocher) ne sont PAS générées par l'IA : elles relèvent de données
fixes (identité) ou restent à compléter manuellement (cf. limites Phase 1).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SectionDef:
    id: str
    chapter: str
    points: int
    label: str
    question: str
    target: str
    inline: bool = False


CHAPITRES: dict[str, str] = {
    "I": "Moyens humains affectés spécifiquement au marché",
    "II": "Moyens matériels affectés spécifiquement au marché",
    "III": "Organisation interne, management, qualité",
    "IV": "Télésurveillance et modalités d'intervention (lot 3)",
}

SECTIONS: list[SectionDef] = [
    # ---- Chapitre I — Moyens humains (20 pts) ----
    SectionDef(
        "i_qualifications", "I", 20, "Qualifications et expérience",
        "Moyens humains dédiés au marché : qualifications et expérience. Détaillez les "
        "profils retenus pour les différents postes, notamment l'encadrement (chef d'équipe "
        "SSIAP2 coordinateur), les qualifications (APS/carte CNAPS, SSIAP1, recyclages), "
        "l'expérience et la reprise du personnel en place (art. L1224-1).",
        "250-350",
    ),
    SectionDef(
        "i_dispositif_absence", "I", 20, "Dispositif prévu pour pallier",
        "Dispositif prévu pour pallier à l'absence d'un ou plusieurs agents à leur poste "
        "(volant de remplacement, astreinte, délais de carence).",
        "150-220",
    ),
    SectionDef(
        "i_soustraitance_prestataires", "I", 20, "Prestataires habituels de sous-traitance",
        "Prestataires habituels de sous-traitance en région Normandie (pour information).",
        "60-110",
    ),
    # ---- Chapitre II — Moyens matériels (20 pts) ----
    SectionDef(
        "ii_rondes", "II", 20, "Rondes de protection du patrimoine",
        "Rondes de protection du patrimoine : système de contrôle proposé et système de "
        "report des incidents (prise de photos, main courante électronique, pointeaux).",
        "180-260",
    ),
    SectionDef(
        "ii_localisation_agences", "II", 20, "Localisation des agences",
        "Localisation des agences et centres opérationnels dans les départements 76 et 27, "
        "moyens de liaison des agents et télégestion.",
        "150-220",
    ),
    SectionDef(
        "ii_epi", "II", 20, "Des équipements de protection sont-ils fournis",
        "Des équipements de protection sont-ils fournis aux agents exposés à des risques "
        "d'agression (gilets pare-coups, lampes, etc.) ? Décrivez la dotation.",
        "120-180",
    ),
    # ---- Chapitre III — Organisation, qualité, environnement ----
    SectionDef(
        "iii_qualite", "III", 10, "Engagement qualité",
        "Engagement qualité : plan qualité interne, responsable qualité, certifications "
        "(ISO/APSAD), politique sociale limitant le turn-over, dispositif de contrôle des "
        "prestations supplémentaires.",
        "200-300",
    ),
    SectionDef(
        "iii_environnement", "III", 10, "Performance environnementale",
        "Performance environnementale : plan interne de développement durable, réduction "
        "des émissions de la flotte de véhicules.",
        "150-220",
    ),
    # ---- Chapitre IV — Télésurveillance (40 pts, lot 3) ----
    SectionDef(
        "iv_localisation_station", "IV", 40, "Localisation de la station de télésurveillance",
        "Localisation de la station de télésurveillance (ville, certification APSAD R31).",
        "30-70", inline=True,
    ),
    SectionDef(
        "iv_report_alarmes", "IV", 40, "Observations techniques sur le report",
        "Observations techniques sur le report des alarmes intrusion, technique ou incendie "
        "(limitations, exigences matérielles, transmetteur IP/GSM, levée de doute vidéo).",
        "150-220",
    ),
    SectionDef(
        "iv_moyens_ouverture", "IV", 40, "dotés des moyens d",
        "Décrivez comment les agents intervenants pourront être dotés des moyens d'ouverture "
        "(carte d'accès, clés, codes) pour la levée de doute.",
        "120-180", inline=True,
    ),
    SectionDef(
        "iv_outils_reporting", "IV", 40, "outils de reporting numérique",
        "De quels outils de reporting numérique disposent les intervenants ?",
        "80-140",
    ),
]

SECTIONS_BY_ID: dict[str, SectionDef] = {s.id: s for s in SECTIONS}
