# RAG — Récupération augmentée (SLIDE REP AO)

RAG réel local : les 118 slides de `SLIDE REP AO/` sont indexées dans
**sqlite-vec** (fichier `.db` local, zéro infra, RGPD : rien ne quitte la
machine). Chaque section générée (Mode A et Mode B) s'appuie sur les vrais
extraits du corpus, avec **citations sourcées** validées côté backend.

## Architecture

```
PDF (PyMuPDF)
   │  extract_pdf_text  +  chunking ~500 tokens (overlap ~50)
   │  PDF "pauvres" (<30 mots) → description GPT-4o vision (rasterisation)
   ▼
Chunk{chunk_id, texte, metadata{dossier, fichier, page, chunk_index}}
   │  OpenAIEmbedder (text-embedding-3-small, 1536 dims)
   ▼
SqliteVecStore (vec0 : dossier filtrable + fichier/page/texte aux + embedding)
   ▲
   │  retrieval.search(query, filtre_thematique?, top_k)  ← embedding requête
/api/rag/search   et   /api/generate-section (contexte injecté + citations)
```

| Fichier | Rôle |
|---|---|
| `indexer.py` | Indexation CLI (PDF → chunks → embeddings → sqlite-vec) |
| `chunking.py` | Découpage (`split_text`, `chunk_pdf`) |
| `embeddings.py` | `OpenAIEmbedder` (+ `NullEmbedder` dry-run) |
| `vector_store.py` | `SqliteVecStore` (+ JSONL / pgvector derrière l'interface) |
| `retrieval.py` | `search()` hybride + `index_exists()` |

## Pré-requis

`.env` (copié depuis `.env.example`) avec **`OPENAI_API_KEY`**. Vérifier :
`EMBEDDING_PROVIDER=openai`, `EMBEDDING_MODEL=text-embedding-3-small`,
`EMBEDDING_DIM=1536`, `VECTOR_STORE=sqlite_vec`, `RAG_DB_PATH=data/rag/slide_rep_ao.db`.

## (Ré)indexer

```bash
cd gss-ao && source .venv/bin/activate
python -m backend.rag.indexer                 # corpus complet (118 PDF)
python -m backend.rag.indexer --no-vision     # sans analyse visuelle GPT-4o
python -m backend.rag.indexer --limit 5       # test rapide (5 PDF)
```
`--reset` (défaut) repart d'un index vierge. Coût indicatif affiché en fin de run
(embeddings ~$0.0004 + ~10 images vision ≈ **< $0.05** au total — bien sous le
budget $10).

## Rechercher (debug)

```bash
curl -s -X POST http://localhost:8000/api/rag/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"formation SSIAP des agents","top_k":5}' | python -m json.tool
# filtre thématique :
#   ... -d '{"query":"rondes","filtre_thematique":"PROCEDURE","top_k":3}'
```
Réponse : `results[]` avec `{dossier, fichier, page, texte, distance, citation}`.
`409` si l'index n'existe pas encore (lancer l'indexer).

## Debug

- **Index vide / 409** : l'indexer n'a pas tourné, ou `RAG_DB_PATH` ne pointe pas
  au bon endroit. Vérifier `ls -la data/rag/`.
- **Dimension mismatch** : l'index a été créé avec une autre `EMBEDDING_DIM`.
  Réindexer après changement de modèle (`--reset`).
- **`enable_load_extension` indisponible** : Python sans support extensions
  sqlite. Le venv uv (CPython standalone) le supporte (vérifié).
- **Citations introuvables** : `generate-section` renvoie `citation_warnings`
  (sources citées par l'IA absentes du contexte) — signalées, texte non modifié.

## Intégration génération

`generate-section` interroge le RAG avec l'intitulé de la section, injecte les
extraits dans le prompt (instruction de citation), puis valide les citations.
Si l'index est absent → fallback transparent sur le contexte mock (zéro
régression, les 2 modes restent fonctionnels).
