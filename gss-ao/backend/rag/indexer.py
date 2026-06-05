"""RAG — indexation des slides SLIDE REP AO dans sqlite-vec.

Pipeline :
  1. parcourir les 118 PDF (PyMuPDF) ;
  2. chunking ~500 tokens (overlap ~50) par paragraphe/page ;
  3. PDF "pauvres" (< 30 mots) : description visuelle via GPT-4o vision
     (rasterisation PyMuPDF) pour capter logos/schémas ;
  4. embeddings OpenAI text-embedding-3-small ;
  5. stockage sqlite-vec avec métadonnées {dossier, fichier, page, chunk_id, texte}.

CLI :
    python -m backend.rag.indexer [--src DIR] [--reset] [--no-vision] [--limit N]

Clé OpenAI : OPENAI_API_KEY (.env) ou --api-key.
"""

from __future__ import annotations

import argparse
import base64
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path

from backend.core.config import get_settings
from backend.rag.chunking import chunk_pdf, make_chunk_id
from backend.rag.embeddings import OpenAIEmbedder
from backend.rag.ingestion import iter_pdfs
from backend.rag.vector_store import SqliteVecStore
from backend.schemas.rag import Chunk, ChunkMetadata

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rag.indexer")

# Chunking : ~500 tokens ≈ 2000 caractères (français ≈ 4 car./token), overlap ~50.
CHUNK_MAX_CHARS = 2000
CHUNK_OVERLAP = 200
POOR_WORD_THRESHOLD = 30  # PDF "pauvre" -> analyse visuelle
VISION_MODEL = "gpt-4o"


@dataclass
class IndexStats:
    files: int = 0
    chunks: int = 0
    poor_pdfs: list[str] = field(default_factory=list)
    vision_used: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def _word_count(text: str) -> int:
    return len(text.split())


def _describe_pdf_visually(client, pdf_path: Path) -> str:
    """Rasterise la 1re page et demande à GPT-4o de décrire le contenu visuel."""
    import fitz

    with fitz.open(str(pdf_path)) as doc:
        page = doc[0]
        pix = page.get_pixmap(dpi=120)
        png = pix.tobytes("png")
    b64 = base64.b64encode(png).decode()
    resp = client.chat.completions.create(
        model=VISION_MODEL,
        max_tokens=300,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Décris en français le contenu de cette diapositive d'un mémoire "
                            "technique de sécurité privée (GSS) : titre, logos/partenaires, "
                            "schémas, informations clés. Sois factuel et concis."
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            }
        ],
    )
    return (resp.choices[0].message.content or "").strip()


def build_chunks(
    root: Path, *, use_vision: bool, api_key: str, limit: int | None
) -> tuple[list[Chunk], IndexStats]:
    """Construit les chunks (texte + métadonnées, sans embeddings)."""
    from openai import OpenAI

    stats = IndexStats()
    chunks: list[Chunk] = []
    vision_client = OpenAI(api_key=api_key) if use_vision else None

    pdfs = list(iter_pdfs(root))
    if limit:
        pdfs = pdfs[:limit]

    for pdf, categorie, source_path in pdfs:
        try:
            from backend.ingestion.doc_converter import extract_pdf_text

            raw = extract_pdf_text(pdf)
            wc = _word_count(raw)

            if wc < POOR_WORD_THRESHOLD:
                stats.poor_pdfs.append(source_path)
                texte = raw.strip()
                if use_vision and vision_client is not None:
                    try:
                        desc = _describe_pdf_visually(vision_client, pdf)
                        texte = (texte + "\n\n[Analyse visuelle] " + desc).strip()
                        stats.vision_used.append(source_path)
                        log.info("vision: %s (%d mots -> +%d car.)", source_path, wc, len(desc))
                    except Exception as exc:  # noqa: BLE001
                        log.warning("vision échouée %s : %s", source_path, exc)
                if not texte:
                    texte = f"{categorie} — {pdf.name}"
                chunks.append(
                    Chunk(
                        chunk_id=make_chunk_id(source_path, 0),
                        text=texte,
                        metadata=ChunkMetadata(
                            categorie=categorie, source_file=pdf.name,
                            source_path=source_path, page=1, chunk_index=0,
                        ),
                    )
                )
                stats.files += 1
                stats.chunks += 1
                continue

            pdf_chunks = chunk_pdf(
                pdf, categorie=categorie, source_path=source_path,
                max_chars=CHUNK_MAX_CHARS, overlap=CHUNK_OVERLAP,
            )
            chunks.extend(pdf_chunks)
            stats.files += 1
            stats.chunks += len(pdf_chunks)
            log.info("%s : %d chunks (%d mots)", source_path, len(pdf_chunks), wc)
        except Exception as exc:  # noqa: BLE001
            stats.skipped.append(f"{source_path}: {exc}")
            log.error("échec %s : %s", source_path, exc)

    return chunks, stats


def index(root: Path | None = None, *, use_vision: bool = True, reset: bool = True,
          api_key: str | None = None, limit: int | None = None) -> IndexStats:
    """Indexe le corpus dans sqlite-vec. Retourne les statistiques."""
    settings = get_settings()
    root = Path(root) if root else settings.corpus_slide_rep_ao_dir
    key = api_key or settings.openai_api_key
    if not key:
        raise SystemExit("OPENAI_API_KEY manquante (.env ou --api-key).")

    log.info("Indexation : %s", root)
    chunks, stats = build_chunks(root, use_vision=use_vision, api_key=key, limit=limit)
    log.info("Chunks construits : %d (sur %d fichiers)", stats.chunks, stats.files)

    log.info("Embeddings OpenAI (%s, %d dims)...", settings.embedding_model, settings.embedding_dim)
    embedder = OpenAIEmbedder(
        api_key=key, model=settings.embedding_model, dim=settings.embedding_dim
    )
    vectors = embedder.embed([c.text for c in chunks])
    for c, v in zip(chunks, vectors, strict=True):
        c.embedding = v

    store = SqliteVecStore(settings.rag_db_path, settings.embedding_dim)
    if reset:
        store.reset()
    n = store.upsert(chunks)
    log.info(
        "Indexés dans %s : %d chunks (total base : %d)",
        settings.rag_db_path, n, store.count(),
    )

    log.info("PDF pauvres : %d | vision utilisée : %d | ignorés : %d",
             len(stats.poor_pdfs), len(stats.vision_used), len(stats.skipped))
    # Estimation coût (indicatif) : embeddings ~ tokens/1000 * 0.00002$ ; vision ~ 0.005$/img
    approx_tokens = sum(len(c.text) for c in chunks) // 4
    cost = approx_tokens / 1000 * 0.00002 + len(stats.vision_used) * 0.005
    log.info("Coût estimé ≈ $%.4f", cost)
    return stats


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Indexation RAG SLIDE REP AO -> sqlite-vec")
    p.add_argument("--src", help="Dossier source (défaut: CORPUS_SLIDE_REP_AO_DIR)")
    p.add_argument("--reset", action="store_true", default=True, help="Réinitialiser l'index")
    p.add_argument("--no-vision", action="store_true", help="Désactiver l'analyse visuelle")
    p.add_argument("--limit", type=int, help="Limiter le nombre de PDF (test)")
    p.add_argument("--api-key", help="Clé OpenAI (sinon .env)")
    args = p.parse_args(argv)
    stats = index(
        Path(args.src) if args.src else None,
        use_vision=not args.no_vision,
        reset=args.reset,
        api_key=args.api_key,
        limit=args.limit,
    )
    print(f"\n✅ Indexation terminée : {stats.chunks} chunks / {stats.files} fichiers")
    if stats.skipped:
        print(f"⚠️ {len(stats.skipped)} ignorés")
    return 0


if __name__ == "__main__":
    sys.exit(main())
