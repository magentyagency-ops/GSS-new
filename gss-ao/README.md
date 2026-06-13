# GSS-AO — Automatisation du traitement des appels d'offres

Backend + scaffolding pour l'application qui transforme un DCE (Dossier de
Consultation des Entreprises) en mémoire technique pré-rédigé, BPU pré-rempli et
check-list de conformité, en s'appuyant sur la base de connaissances GSS
(`SLIDE REP AO`).

> **Itération 1** (état actuel) : scaffolding complet + parseur RC + parseur CCTP
> + ingestion RAG. La génération LLM (Module C) et le module BPU complet ne sont
> **pas** implémentés (interfaces seulement). Voir [DECISIONS.md](DECISIONS.md).

---

## Configuration du corpus (⚠️ à lire en premier)

**Le projet ne contient PAS le corpus.** Pour des raisons **RGPD** et de
confidentialité (cf. [DECISIONS.md](DECISIONS.md) §D4), les données sensibles
sont exclues du dépôt git :

- `Cas-Univ-Rouen-MP2026-08/Annexes/` — données personnelles (profils agents,
  agents logés, correspondants sûreté) ;
- `SLIDE REP AO/` — base de connaissances interne GSS ;
- `audit/` — transcription métier interne.

Le code lit donc le corpus **à son emplacement local réel**, configuré via le
fichier `.env`. Deux chemins sont attendus :

| Variable `.env`            | Rôle                                   |
|----------------------------|----------------------------------------|
| `CORPUS_DCE_DIR`           | Dossier du DCE (cas Université Rouen)  |
| `CORPUS_SLIDE_REP_AO_DIR`  | Base de connaissances `SLIDE REP AO`   |

> Ces deux variables constituent le « chemin du corpus » (équivalent d'un
> `GSS_CORPUS_PATH` unique, ici scindé DCE / base de connaissances). Les sorties
> de parsing et d'ingestion sont écrites dans `data/output/` (git-ignoré).

### Exemple de `.env` prêt pour le dev local

Copier `.env.example` en `.env` ; pour la configuration par défaut (le repo
`gss-ao/` est placé à côté du corpus), aucune modification n'est nécessaire :

```dotenv
# Corpus (relatif à la racine du workspace, parent de gss-ao/)
CORPUS_DCE_DIR=../Cas-Univ-Rouen-MP2026-08
CORPUS_SLIDE_REP_AO_DIR=../SLIDE REP AO

# Conversion .doc (laisser vide = auto-détection de LibreOffice)
SOFFICE_BIN=

# RAG en mode dry-run local (sans Docker / sans clé API)
EMBEDDING_PROVIDER=none
VECTOR_STORE=jsonl
VECTOR_STORE_JSONL_PATH=data/output/slide_rep_ao_chunks.jsonl
EMBEDDING_DIM=1024
```

Voir [.env.example](.env.example) pour la liste complète des variables.

---

## Setup local

> Prérequis : Python **3.11+**. (Voir [DECISIONS.md](DECISIONS.md) pour la
> méthode d'installation retenue sur la machine de dev.)

```bash
cd gss-ao
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### LibreOffice (requis pour le parseur RC)

Le RC est un `.doc` legacy ; sa conversion en `.docx` passe par LibreOffice
headless. Sans lui, le parseur RC s'arrête avec un message explicite (il ne
produit jamais un résultat faux). Installation : voir [DECISIONS.md](DECISIONS.md) §D1.

---

## Commandes principales

Toutes les commandes se lancent depuis `gss-ao/`, venv activé
(`source .venv/bin/activate`).

### Tests & lint

```bash
pytest -q              # 46 tests (parseurs sur le cas Rouen + RAG)
ruff check backend/ scripts/ tests/
```

> Les tests marqués `requires_corpus` lisent le corpus local ; ils se *skippent*
> proprement si `CORPUS_DCE_DIR` / `CORPUS_SLIDE_REP_AO_DIR` ne pointent pas
> vers des fichiers présents.

### Parseur RC (Règlement de Consultation) — opérationnel

```bash
python -m scripts.run_rc_parser "$CORPUS_DCE_DIR/2-RC 2026-08.doc" \
    --out data/output/rc_rouen.json
```
Extrait : objet, acheteur, CCAG, CPV, 3 lots, visite (obligatoire + date),
pièces candidature/offre (dont DUME), barème pondéré (VT 60 / Prix 40),
modalités de remise. (`.doc` géré via LibreOffice ou `textutil` macOS.)

### Parseur CCTP — opérationnel

```bash
python -m scripts.run_cctp_parser "$CORPUS_DCE_DIR/4-CCTP 2026-08.docx" \
    --out data/output/cctp_rouen.json
```
Extrait : arborescence hiérarchique, prestations (base/supplémentaire/
télésécurité) par lot, exigences agents (qualifications/tenue/équipement…),
reprise du personnel, contraintes site (ZRR).

### Ingestion RAG (`SLIDE REP AO`) — opérationnel

```bash
python -m scripts.run_rag_ingestion --src "$CORPUS_SLIDE_REP_AO_DIR" \
    --out data/output/slide_rep_ao_chunks.jsonl
```
Produit ~138 chunks (118 PDF, 21 catégories) dans un JSONL **iso-schéma
pgvector**. En mode dry-run (`EMBEDDING_PROVIDER=none`), les embeddings ne sont
pas calculés (idempotent : ré-ingérer ne crée pas de doublon).

### API (squelette)

```bash
uvicorn backend.main:app --reload   # seul /api/health est actif en itération 1
```

### Infra (cible, nécessite Docker)

```bash
cd infra && docker compose up   # Postgres+pgvector, MinIO, backend
```
Sans Docker, le RAG fonctionne en JSONL (cf. ci-dessus).

---

## Structure

Voir [ARCHITECTURE.md](ARCHITECTURE.md) pour le détail des modules et des flux.
Le frontend (scaffold Next.js) est documenté dans [frontend/README.md](frontend/README.md).
