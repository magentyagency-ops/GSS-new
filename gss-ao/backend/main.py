"""Point d'entrée FastAPI — squelette (itération 1).

Lancement : `uvicorn backend.main:app --reload`
Seul `/api/health` est fonctionnel à ce stade.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.ai.routes_ai import router as ai_router
from backend.api.routes import router

app = FastAPI(
    title="GSS-AO — Automatisation appels d'offres",
    version="0.2.0",
    description="Backend GSS-AO (itération 1 + génération IA Module C).",
)

# CORS : le frontend Next (localhost:3000) appelle ce backend (localhost:8000).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Fill-Report"],
)

app.include_router(router)  # itération 1 (inchangé)
app.include_router(ai_router)  # Module C — génération IA
