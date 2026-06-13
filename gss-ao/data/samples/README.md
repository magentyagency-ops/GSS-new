# data/samples

Ce dossier ne **copie pas** le corpus (RGPD + volumétrie). Les parseurs et le
script d'ingestion lisent directement le corpus à son emplacement réel, via les
chemins de `.env` :

- `CORPUS_DCE_DIR`      -> `../Cas-Univ-Rouen-MP2026-08`
- `CORPUS_SLIDE_REP_AO_DIR` -> `../SLIDE REP AO`

Les sorties de parsing/ingestion sont écrites dans `data/output/` (git-ignoré).
