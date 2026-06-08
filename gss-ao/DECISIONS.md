# DECISIONS.md — Journal des choix d'architecture

> Référence brief : `BRIEF_PROJET_GSS_AppelsOffres_V1.md` §15.
> Ce fichier trace les décisions prises au fil de l'eau. Statut : `✅ acté`,
> `🟡 provisoire (à confirmer GSS/Nira)`, `⛔ bloqué`.

---

## Itération 1 — périmètre

Conforme brief §14 : scaffolding + parseur RC + parseur CCTP + ingestion RAG +
README + ARCHITECTURE. **Hors périmètre cette itération** : génération LLM
(Module C) et module BPU complet (uniquement interfaces/squelettes).

---

## D1ter — Débloquage RC via `textutil` (natif macOS), sans LibreOffice  ✅

- **Constat** : `textutil` (`/usr/bin/textutil`, livré avec macOS) convertit le
  `.doc` legacy en texte **propre** (accents préservés, contenu complet : barème
  60/40, DC1/DC2/DUME, visite obligatoire + dates, plateforme...).
- **Décision** : `doc_converter.extract_doc_text()` essaie LibreOffice si présent
  (conserve les tableaux), **sinon textutil** (zéro install). Le `rc_parser` est
  donc **opérationnel dès maintenant**, sans attendre Homebrew/LibreOffice.
- **Méthode tracée** dans la sortie (`source.methode_extraction = doc_textutil`).
- LibreOffice reste recommandé à terme (conversion structurée + export PDF futur),
  mais n'est plus bloquant pour cette itération.

## D1 — Parseur RC sur `.doc` legacy → conversion LibreOffice  🟡

- **Contexte** : `2-RC 2026-08.doc` est un fichier Word 97-2003 (Composite
  Document OLE2, cp1252), non lisible par `python-docx`.
- **Décision** : conversion `.doc → .docx` via **LibreOffice headless**
  (`soffice --headless --convert-to docx`) puis parsing `python-docx`. Voie
  robuste, réutilisable pour `1-Acte d'Engagement.doc` et `Annexe 7 ...doc`.
- **Alternative écartée** : extraction pur-Python via `olefile` + heuristiques
  regex sur le flux `WordDocument` — plus fragile, gardée en plan B.
- **Statut install** : ⛔ **Homebrew absent de la machine** (`/opt/homebrew` et
  `/usr/local` vides, recherche filesystem négative) ; `sudo` exige un mot de
  passe non saisissable par l'agent. Installation Homebrew + LibreOffice
  **déléguée à l'utilisateur** :
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  brew install --cask libreoffice
  ```
- **Comportement code** : `doc_converter` détecte automatiquement `soffice`
  (PATH ou `/Applications/LibreOffice.app/...`). Tant qu'absent, le `rc_parser`
  lève une erreur explicite « LibreOffice requis » plutôt qu'un résultat faux.
- _À compléter après install : version soffice + temps d'install._

## D1bis — Environnement Python : uv (sans sudo) au lieu de Homebrew  ✅

- **Contexte** : Homebrew non installé et non installable par l'agent (sudo exige
  un mot de passe non saisissable). `brew install python@3.11` donc impossible.
- **Décision** : acquisition de Python 3.11 via **uv** (Astral), 100% user-space,
  aucun sudo.
- **Traçabilité install** (machine de dev, arm64 / macOS 24.4) :
  | Étape | Outil / version | Durée |
  |---|---|---|
  | Install uv | `uv 0.11.18` (curl → `~/.local/bin`) | ~4 s |
  | Python 3.11 | `cpython-3.11.15-macos-aarch64` (standalone) | ~4 s |
  | Création venv | `gss-ao/.venv/` (Python 3.11.15) | inclus |
  | `uv pip install -r requirements.txt` | toutes deps OK | ~10 s |
  | **Taille venv** | `gss-ao/.venv/` | **250 Mo** |
- **Validation** : `pytest -q` → **9 passed** (dont `test_db_models_import` non
  skippé : table pgvector déclarée + dimension alignée sur `EMBEDDING_DIM`).
- **PATH** : `uv` est dans `~/.local/bin` (à ajouter au PATH du shell :
  `source $HOME/.local/bin/env`). `.venv/` est git-ignoré.

## D2 — Vector DB : pgvector + fallback JSONL  ✅

- **Décision** : PostgreSQL + extension **pgvector** comme store unique
  (aligne brief §9.1, évite un 2e service type Qdrant).
- **Contrainte locale** : Docker absent → l'ingestion RAG fonctionne en
  **mode dry-run JSONL** (chunks + métadonnées + emplacement embeddings écrits
  en JSONL) tant que pgvector n'est pas joignable.
- **Garantie iso-schéma** : le JSONL dry-run respecte **exactement** le schéma
  attendu par pgvector (mêmes métadonnées, même dimension d'embedding). Passer
  du dry-run à pgvector = simple swap d'implémentation dans `vector_store.py`,
  **sans aucun refactor** du code appelant (cf. interface `VectorStore`).

## D3 — Embeddings : interface + calcul différé  ✅

- **Décision** : interface `Embedder` abstraite + chunking + métadonnées
  implémentés maintenant ; **calcul réel des embeddings différé** (pas de clé
  API requise pour valider l'ingestion/chunking en itération 1).
- **Providers prévus** (configurable via `.env`) : Voyage `voyage-3`,
  OpenAI `text-embedding-3-large`, ou local `bge-m3` (souveraineté FR).
- **Dimension** : fixée en config (`EMBEDDING_DIM`, défaut 1024 pour `voyage-3`
  / `bge-m3`) — utilisée à l'identique par le dry-run JSONL et pgvector (D2).

---

## D4 — Logique RGPD / .gitignore  ✅

Le dépôt git est la **racine du workspace** (pas `gss-ao/`). Le `.gitignore`
racine applique la règle suivante :

| Élément | Versionné ? | Raison |
|---|---|---|
| `2-RC`, `3-CCAP`, `4-CCTP`, `6-BPU/DPGF`, `5-Mémoire Technique` | ✅ oui | Pièces de marché public, non confidentielles en soi. |
| `Cas-Univ-Rouen-MP2026-08/Annexes/` (tout le dossier) | ⛔ exclu | **Données personnelles** : Annexe 2 (profils agents), Annexe 4 (agents logés), Annexe 5 (correspondants sûreté). Exclusion du dossier entier par précaution. |
| `SLIDE REP AO/` (+ symlink) | ⛔ exclu | Contenu **interne GSS** (base de connaissances). |
| `audit/` | ⛔ exclu | Transcription métier interne. |

> Conséquence : le RAG s'appuie sur des fichiers **non versionnés**, lus depuis
> leur emplacement local. C'est volontaire (les données restent hors dépôt).

---

## Décisions encore ouvertes (brief §15) — à acter GSS/Nira

- [ ] Hébergement : cloud public / cloud souverain FR / on-prem ?
- [ ] LLM final : Anthropic seul / multi-providers / Mistral local ?
- [ ] BPU V1 : mode assistant uniquement (recommandé) ?
- [ ] Module veille : V1.5 strict ?
- [ ] Auth : SSO (Azure AD) ou standalone ?
- [ ] Budget LLM mensuel cible.
- [ ] Embedding provider final + dimension définitive.

## D5 — Compte de PDF de référence : 118 (et non 119)  ✅

Le **brief §4.2 indique 119 PDF**, mais le **compte réel est 118**. Vérification
exhaustive (catégorie par catégorie) : les 21 catégories correspondent
**exactement** à la table du brief, et **la table elle-même somme à 118**. Le
brief comporte donc une **erreur d'en-tête** (titre « 119 fichiers ») ; le
contenu de la table est correct. Aucun fichier manquant ni dupliqué (vérifié :
pas de PDF hors catégorie, pas de doublon de nom).

**Référence pour la suite : 118 PDF.**

## Points factuels relevés à l'exploration

- **118 PDF** dans `SLIDE REP AO/` — voir D5 ci-dessus (brief §4.2 erroné à 119).
- PDF = **texte natif** (fontes sous-ensemblées, générés iLovePDF), pas des
  scans → OCR non nécessaire en cas général, fallback OCR optionnel par page.
- Mémoires techniques **historiques GSS** (brief §13.1) non fournis → le RAG
  n'indexe que `SLIDE REP AO/` à ce stade.

---

## D6 — RAG réel : sqlite-vec local + OpenAI embeddings  ✅

- **Vector store : sqlite-vec** (fichier `.db` local) plutôt que Supabase
  pgvector. Justification : outil **interne**, petit corpus (~118 chunks),
  **sans Docker**, et surtout **RGPD** — le texte des slides GSS ne quitte pas la
  machine (Supabase, même région EU Frankfurt, aurait envoyé du contenu interne
  au cloud sans bénéfice à cette échelle). Abstraction `VectorStore` conservée →
  migration pgvector triviale si multi-utilisateur un jour. Extension sqlite
  chargeable vérifiée (`enable_load_extension=True`, CPython uv).
- **Embeddings** : OpenAI `text-embedding-3-small` (1536 dims), appels par lots.
- **Chunking** : ~500 tokens (≈2000 car.), overlap ~50, par page/paragraphe.
- **PDF pauvres** (<30 mots, 10 fichiers, surtout logos PARTENAIRES) : description
  **GPT-4o vision** (rasterisation PyMuPDF) ajoutée au chunk.
- **Retrieval hybride** : filtre thématique (`dossier`) + KNN cosinus (vec0).
- **Citations** : prompt impose `(source: DOSSIER/fichier.pdf)` ; validation
  backend post-génération → champ `citation_warnings` (sources introuvables
  **signalées sans modifier** le texte ; cf. arbitrage). Fallback transparent sur
  contexte mock si l'index est absent → **zéro régression**, 2 modes préservés.
- **Coût indexation** : embeddings ≈ $0.0004 + ~10 images vision ≈ **< $0.05**
  (budget $10 largement respecté).
- **Fix** : DOCX Mode B en **`xml:lang="fr-FR"`** (Word ne le détecte plus en-US).

### Tests E2E comparatifs (mock vs RAG)

Harnais : `scripts/rag_eval.py` (3 sections : `i_qualifications`, `ii_rondes`,
`iv_report_alarmes`). Métriques : longueur, nb citations, **citations valides**
(source réellement présente) vs **citations fausses** (hallucination de source).

**Exécution** (nécessite l'index + une clé OpenAI — budget tuteur) :
```bash
python -m backend.rag.indexer          # indexe le corpus (~$0.05)
python -m scripts.rag_eval             # tableau comparatif + data/output/rag_eval.json
```

**Résultats mesurés** (index : 118 chunks, `gpt-4o-mini`, exécuté 2026-06-08) :

| Section | Mots (mock/RAG) | Citations RAG (valides/fausses) | Citations mock (valides/fausses) |
|---|---|---|---|
| i_qualifications | 283 / 298 | **4 / 0** | 0 / 1 |
| ii_rondes | 221 / 222 | **4 / 0** | 0 / 1 |
| iv_report_alarmes | 187 / 198 | **3 / 0** | 0 / 1 |

**Lecture** : à longueur quasi identique, le mode **RAG** produit **11 citations
vers de vraies slides, 0 hallucination de source** (validées contre l'index),
là où le mode **mock** ne fournit **aucune source traçable** et hallucine même
une citation par section (1 source inventée, signalée par `citation_warnings`).
Le RAG apporte donc la **traçabilité/sourçage** (gisement de valeur Vaché) sans
surcoût de longueur. Index : `data/rag/slide_rep_ao.db` (6,2 Mo, 21/21 dossiers),
coût d'indexation ≈ **$0,05** (embeddings + vision GPT-4o sur 10 PDF pauvres).

> Pertinence qualitative (échelle 1-5) : à valider à l'aveugle par Mme Vaché sur
> un échantillon ; les métriques automatiques ci-dessus (sourçage, anti-
> hallucination) sont elles déjà objectivées par `scripts/rag_eval.py`.
