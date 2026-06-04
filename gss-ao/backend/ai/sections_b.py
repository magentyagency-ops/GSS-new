"""Catalogue des sections génériques — MODE B (réponse libre, structure GSS).

Structure calquée sur le mémoire de référence GSS (AO RNE.docx, Clarence) :
I. Présentation · II. Moyens humains · III. Moyens opérationnels ·
IV. Moyens organisationnels.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SectionBDef:
    id: str
    chapter: str
    title: str
    question: str
    target: str


SECTIONS_B: list[SectionBDef] = [
    SectionBDef(
        "b_presentation", "I", "Présentation de la société GSS",
        "Présentation de la société GSS : activités (gardiennage, télésurveillance, contrôle "
        "d'accès), implantation, références clients pertinentes pour ce marché.",
        "200-300",
    ),
    SectionBDef(
        "b_engagement_rse", "I", "Engagement RSE et écologique",
        "Engagement RSE et écologique de GSS (démarche développement durable, flotte de "
        "véhicules, dématérialisation).",
        "120-200",
    ),
    SectionBDef(
        "b_moyens_humains", "II", "Moyens humains",
        "Moyens humains : qualifications et formations des agents (SSIAP, APS, CNAPS), "
        "procédure de recrutement, valeurs managériales, interlocuteur unique.",
        "250-350",
    ),
    SectionBDef(
        "b_moyens_materiels", "III", "Moyens matériels et opérationnels",
        "Moyens matériels et opérationnels : tenues, moyens techniques et de communication, "
        "planification, main courante, contrôleur de rondes, gestion des accès.",
        "250-350",
    ),
    SectionBDef(
        "b_organisation", "IV", "Organisation et suivi qualité",
        "Organisation et suivi qualité : dispositif de contrôle qualité, audits, encadrement.",
        "180-260",
    ),
    SectionBDef(
        "b_procedures", "IV", "Procédures opérationnelles",
        "Procédures opérationnelles : conduite à tenir (incendie, intrusion, alarme, individu "
        "suspect, victime), continuité de service.",
        "180-260",
    ),
]

SECTIONS_B_BY_ID: dict[str, SectionBDef] = {s.id: s for s in SECTIONS_B}

CHAPITRES_B: dict[str, str] = {
    "I": "Présentation de notre structure",
    "II": "Les moyens humains",
    "III": "Les moyens opérationnels",
    "IV": "Les moyens organisationnels",
}
