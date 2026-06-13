# ARCHITECTURE — GSS-AO

Document d'architecture du backend GSS-AO. État : **itération 1** (scaffolding +
parseurs RC/CCTP + ingestion RAG). La génération LLM (Module C) et le module BPU
complet sont des interfaces non implémentées.

Voir aussi : [DECISIONS.md](DECISIONS.md) (choix actés/ouverts), [README.md](README.md)
(setup & commandes).

---

## 1. Vue d'ensemble

GSS dépose un DCE (Dossier de Consultation des Entreprises) ; l'application
produit un mémoire technique pré-rédigé, un BPU pré-rempli et une check-list de
conformité, en s'appuyant sur la base de connaissances réutilisable `SLIDE REP AO`
indexée dans un RAG.

```
            ┌──────────────────────── Frontend (Next.js, scaffold) ───────────────────────┐
            │  Upload → Synthèse → Check-list → Mémoire (WYSIWYG) → BPU → Export           │
            └───────────────────────────────────┬─────────────────────────────────────────┘
                                                 │ HTTP (FastAPI)
┌────────────────────────────────────────────── Backend ──────────────────────────────────────────────┐
│                                                                                                       │
│  A. Ingestion        B. Analyse              C. Génération        D. BPU         E. Conformité         │
│  ─────────────       ─────────────           ─────────────       ───────        ─────────────         │
│  upload + détection  rc_parser    ★          template_filler ☐   bpu/parser ☐   checklist ☐           │
│  doc_converter ★     cctp_parser  ★          free_composer   ☐                                         │
│  (soffice/textutil/  bpu_parser   ☐          scenario_agent  ☐                                         │
│   PyMuPDF)           synthesis    ☐          exporter        ☐                                         │
│                                                                                                       │
│                         RAG ────────────────────────────────────────────────────────────────────    │
│                         ingestion ★  chunking ★  embeddings ★(iface)  vector_store ★  retrieval ☐     │
│                                                                                                       │
│  Transverse : schemas/ (Pydantic) · core/config · llm/client ☐ · db/models (pgvector)                │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
        ★ = opérationnel (itération 1)        ☐ = interface / NotImplementedError
```

---

## 2. Modules (mapping vers le code)

| Module | Rôle | Fichiers | État |
|---|---|---|---|
| **A. Ingestion** | Upload, détection des pièces, extraction texte multi-format | `backend/ingestion/piece_classifier.py` ☐, `backend/ingestion/doc_converter.py` ★ | doc_converter opérationnel |
| **B. Analyse** | Extraction structurée RC / CCTP / BPU + fiche de synthèse | `backend/analysis/rc_parser.py` ★, `cctp_parser.py` ★, `bpu_parser.py` ☐, `synthesis.py` ☐ | RC + CCTP opérationnels |
| **C. Génération** | Rédaction mémoire technique (cadre/libre) + scénarios | `backend/generation/*.py` ☐ | hors périmètre it.1 |
| **D. BPU** | Pré-remplissage assistant (validation humaine) | `backend/bpu/parser.py` ☐ | hors périmètre it.1 |
| **E. Conformité** | Check-list pièces à fournir + alertes | `backend/compliance/checklist.py` ☐ | hors périmètre it.1 |
| **RAG** | Indexation `SLIDE REP AO` + récupération | `backend/rag/{ingestion,chunking,embeddings,vector_store}.py` ★, `retrieval.py`/`reranker.py` ☐ | ingestion opérationnelle |
| **Transverse** | Schémas, config, LLM, DB | `backend/schemas/*` ★, `core/config.py` ★, `llm/client.py` ☐, `db/models.py` ★ | |

---

## 3. Flux de données

### 3.1 Analyse d'un DCE (Module B — opérationnel)

```
DCE (.doc/.docx/.pdf)
   │
   ▼  doc_converter.extract_doc_text / load_docx_text / extract_pdf_text
texte brut + méthode d'extraction (traçabilité)
   │
   ├─► rc_parser.parse_rc(2-RC.doc)
   │      découpage en sections numérotées (1, 1.4, 2.6, 4.1, 4.2, 6, …)
   │      → RCDocument { objet, acheteur, lots, visite, pièces, barème, modalités }
   │
   └─► cctp_parser.parse_cctp(4-CCTP.docx)
          arbre Heading 1/2/3 + motifs lexicaux
          → CCTPDocument { arborescence, prestations, exigences_agents, reprise_personnel }
   │
   ▼  (futur) synthesis.build_synthesis(rc, cctp) → FicheSynthese  +  checklist.build_checklist(rc)
```

Sortie = JSON Pydantic (`model_dump_json`), validable, traçable (`source.warnings`).

### 3.2 Ingestion RAG (opérationnel)

```
SLIDE REP AO/<CATEGORIE>/<slide>.pdf   (118 PDF, 21 catégories)
   │
   ▼  iter_pdfs : (path, categorie = dossier niv.1, source_path = chemin relatif)
   ▼  chunk_pdf : PyMuPDF par page → split_text (≤1200 car., overlap 150)
Chunk { chunk_id (déterministe), text, metadata{categorie,source_file,page,index}, embedding=None }
   │
   ▼  embedder.embed(textes)   [dry-run: None ; futur: voyage/openai/bge]
   ▼  store.upsert(chunks)     [JSONL iso-schéma | pgvector]
138 chunks indexés (idempotent)
```

### 3.3 Pipeline cible complet (rappel, futur)

```
Upload → A:détection → B:extraction(RC/CCTP/BPU/annexes) → détection mode réponse
      → Fiche synthèse (validation) + E:check-list
      → C:génération (RAG SLIDE REP AO + contexte CCTP + scénarios) [édition par section]
      → D:BPU assistant (validation humaine) → Export DOCX/PDF
```

---

## 4. Schémas de données (contrats)

`backend/schemas/` — modèles Pydantic v2, sérialisables JSON, partagés backend/tests.

- `common.py` : `SourceMeta` (traçabilité : fichier, méthode, warnings), `Lot`,
  `DateEcheance`, enum `ExtractionMethod`.
- `rc.py` : `RCDocument`, `PieceAFournir`, `CriteresNotation`/`SousCritere`,
  `Visite`, `ModalitesRemise` (brief §5.1).
- `cctp.py` : `CCTPDocument`, `SectionCCTP` (récursif), `Prestation`,
  `ExigenceAgent` (brief §5.3).
- `rag.py` : `Chunk` + `ChunkMetadata` — **schéma unique JSONL ⇄ pgvector**.

---

## 5. Choix techniques (justifiés)

| Choix | Décision | Justification |
|---|---|---|
| **Extraction `.doc`** | LibreOffice si présent, sinon `textutil` (macOS), sinon erreur | textutil = natif macOS, zéro install, texte propre → débloque le RC sans Homebrew (cf. D1ter). LibreOffice gardé pour conversion structurée + export PDF futur. |
| **Extraction PDF** | PyMuPDF (fitz) | Décode correctement les fontes sous-ensemblées des slides (testé) ; OCR inutile en cas général. |
| **Parsing CCTP** | Arbre par styles de titre + motifs lexicaux | Le `.docx` est bien structuré (Heading 1/2/3) ; motifs (pas de n° hardcodés) → robuste à la variabilité inter-AO. |
| **Parsing RC** | Sections numérotées + détection canonique des pièces | Texte régulier ; scoping par section évite les faux positifs (ex. BPU cité hors §4.2). |
| **Validation** | Pydantic v2 | Contrats typés = « schéma §5.1 » exécutable ; roundtrip JSON testé. |
| **Vector store** | pgvector (prod) + JSONL (dry-run) derrière `VectorStore` | Une seule DB (aligne brief §9.1) ; JSONL débloque le dev sans Docker, **iso-schéma** garanti par test. |
| **Embeddings** | Interface `Embedder`, défaut `none` | Valider chunking/ingestion sans clé API ni coût ; providers réels branchables sans refactor. |
| **Env Python** | uv + CPython 3.11 standalone | Homebrew indisponible (sudo) ; uv = user-space, rapide (cf. D1bis). |

---

## 6. Robustesse & sûreté

- **Traçabilité** : chaque document parsé porte `source.methode_extraction` + `warnings`.
- **Échec explicite** : pas de voie de conversion `.doc` → `LibreOfficeNotFoundError`
  (jamais un résultat silencieusement faux — exigence brief §12, revue humaine).
- **Idempotence RAG** : `chunk_id` déterministe → ré-ingestion sans doublon.
- **Anti-hallucination BPU** (futur) : LLM suggesteur, validation humaine obligatoire.
- **RGPD** : corpus hors dépôt git (annexes agents, base GSS, audit) — cf. D4.

---

## 7. Limites connues (itération 1)

- `objet` CCTP via heuristique « Ayant pour objet » (le style `Objet` du modèle est vide).
- Prestations CCTP : `campus` non systématiquement rattaché aux prestations « de base »
  détaillées par campus (capté dans l'arborescence).
- pgvector implémenté mais **non exécuté** (Docker absent) — couvert par test iso-schéma.
- RAG = `SLIDE REP AO` seul ; mémoires techniques historiques GSS non fournis (brief §13).
- 118 PDF observés (brief annonce 119).
