"""RAG — abstraction du stockage vectoriel.

CONTRAT (DECISIONS.md D2) : le backend JSONL (dry-run local) et le backend
pgvector partagent EXACTEMENT le schéma `backend.schemas.rag.Chunk`. Passer de
l'un à l'autre = changer `VECTOR_STORE` dans `.env` ; AUCUN refactor du code
appelant (ingestion, futur retrieval).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from backend.core.config import Settings, VectorStoreBackend, get_settings
from backend.schemas.rag import Chunk


class VectorStore(ABC):
    """Interface de stockage des chunks. L'`upsert` est idempotent par chunk_id."""

    @abstractmethod
    def upsert(self, chunks: list[Chunk]) -> int:
        """Insère/maj des chunks. Retourne le nombre d'éléments écrits."""
        ...

    @abstractmethod
    def count(self) -> int:
        """Nombre de chunks stockés."""
        ...

    def search(self, embedding: list[float], *, top_k: int = 5) -> list[Chunk]:
        """Recherche par similarité (Module C, non implémenté en itération 1)."""
        raise NotImplementedError("Recherche vectorielle — itération ultérieure")


class JsonlVectorStore(VectorStore):
    """Backend de secours (dry-run local) : un chunk par ligne JSON.

    Le format de chaque ligne est `Chunk.model_dump()` — donc strictement le même
    contenu que ce qui sera inséré dans pgvector (champs et types identiques)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> dict[str, Chunk]:
        existing: dict[str, Chunk] = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    c = Chunk.model_validate_json(line)
                    existing[c.chunk_id] = c
        return existing

    def upsert(self, chunks: list[Chunk]) -> int:
        merged = self._load()
        for c in chunks:
            merged[c.chunk_id] = c  # idempotence par chunk_id
        with self.path.open("w", encoding="utf-8") as f:
            for c in merged.values():
                f.write(c.model_dump_json())
                f.write("\n")
        return len(chunks)

    def count(self) -> int:
        return len(self._load())


class PgVectorStore(VectorStore):
    """Backend PostgreSQL/pgvector (cible prod). Non exercé en itération 1
    (Docker absent), mais implémenté pour valider l'iso-schéma.

    Mapping Chunk -> table `rag_chunk` (voir backend/db/models.py)."""

    def __init__(self, database_url: str) -> None:
        from sqlalchemy import create_engine

        from backend.db import models

        if not models._SQLALCHEMY_AVAILABLE:  # pragma: no cover
            raise RuntimeError("SQLAlchemy/pgvector indisponibles : backend pgvector inutilisable.")
        self._models = models
        self.engine = create_engine(database_url)

    def _to_row(self, c: Chunk) -> dict:
        m = c.metadata
        return {
            "chunk_id": c.chunk_id,
            "text": c.text,
            "categorie": m.categorie,
            "source_file": m.source_file,
            "source_path": m.source_path,
            "page": m.page,
            "chunk_index": m.chunk_index,
            "extra": {"keywords": m.keywords},
            "embedding": c.embedding,
        }

    def upsert(self, chunks: list[Chunk]) -> int:
        from sqlalchemy.dialects.postgresql import insert

        rows = [self._to_row(c) for c in chunks]
        table = self._models.RagChunk.__table__
        with self.engine.begin() as conn:
            for row in rows:
                stmt = insert(table).values(**row)
                update_cols = {k: stmt.excluded[k] for k in row if k != "chunk_id"}
                stmt = stmt.on_conflict_do_update(
                    index_elements=["chunk_id"], set_=update_cols
                )
                conn.execute(stmt)
        return len(rows)

    def count(self) -> int:
        from sqlalchemy import func, select

        table = self._models.RagChunk.__table__
        with self.engine.connect() as conn:
            return int(conn.execute(select(func.count()).select_from(table)).scalar_one())


class SqliteVecStore(VectorStore):
    """RAG réel local : sqlite + extension sqlite-vec (table virtuelle vec0).

    Schéma : `dossier` est une colonne métadonnée FILTRABLE (retrieval hybride) ;
    `fichier`, `page`, `texte` sont des colonnes auxiliaires (+) renvoyées avec le
    résultat. La recherche KNN renvoie aussi la distance (cosine via vec0).
    """

    def __init__(self, db_path: Path, dim: int) -> None:
        import sqlite3

        import sqlite_vec

        self.db_path = Path(db_path)
        self.dim = dim
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.enable_load_extension(True)
        sqlite_vec.load(self.conn)
        self.conn.enable_load_extension(False)
        self._serialize = sqlite_vec.serialize_float32
        self.conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0("
            f"chunk_id TEXT PRIMARY KEY, dossier TEXT, "
            f"+fichier TEXT, +page INTEGER, +texte TEXT, embedding float[{dim}])"
        )
        self.conn.commit()

    def reset(self) -> None:
        """Vide l'index (réindexation propre)."""
        self.conn.execute("DROP TABLE IF EXISTS vec_chunks")
        self.conn.execute(
            f"CREATE VIRTUAL TABLE vec_chunks USING vec0("
            f"chunk_id TEXT PRIMARY KEY, dossier TEXT, "
            f"+fichier TEXT, +page INTEGER, +texte TEXT, embedding float[{self.dim}])"
        )
        self.conn.commit()

    def upsert(self, chunks: list[Chunk]) -> int:
        n = 0
        for c in chunks:
            if c.embedding is None:
                continue
            m = c.metadata
            self.conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?", (c.chunk_id,))
            self.conn.execute(
                "INSERT INTO vec_chunks(chunk_id, dossier, fichier, page, texte, embedding) "
                "VALUES (?,?,?,?,?,?)",
                (c.chunk_id, m.categorie, m.source_file, m.page or 0, c.text,
                 self._serialize(c.embedding)),
            )
            n += 1
        self.conn.commit()
        return n

    def count(self) -> int:
        return int(self.conn.execute("SELECT count(*) FROM vec_chunks").fetchone()[0])

    def search_hybrid(
        self, embedding: list[float], *, top_k: int = 5, dossier: str | None = None
    ) -> list[dict]:
        """KNN vectoriel + filtre thématique optionnel. Retourne des dicts sourcés."""
        params: list = [self._serialize(embedding), top_k]
        where = "embedding MATCH ? AND k = ?"
        if dossier:
            where += " AND dossier = ?"
            params.append(dossier)
        rows = self.conn.execute(
            f"SELECT chunk_id, dossier, fichier, page, texte, distance "
            f"FROM vec_chunks WHERE {where} ORDER BY distance",
            params,
        ).fetchall()
        return [
            {"chunk_id": r[0], "dossier": r[1], "fichier": r[2], "page": r[3],
             "texte": r[4], "distance": r[5]}
            for r in rows
        ]


def get_vector_store(settings: Settings | None = None) -> VectorStore:
    """Fabrique le VectorStore selon `VECTOR_STORE`."""
    settings = settings or get_settings()
    if settings.vector_store is VectorStoreBackend.JSONL:
        return JsonlVectorStore(settings.vector_store_jsonl_path)
    if settings.vector_store is VectorStoreBackend.SQLITE_VEC:
        return SqliteVecStore(settings.rag_db_path, settings.embedding_dim)
    if settings.vector_store is VectorStoreBackend.PGVECTOR:
        return PgVectorStore(settings.database_url)
    raise ValueError(f"Backend vector store inconnu : {settings.vector_store}")
