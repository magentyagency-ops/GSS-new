# V1.1 — Validation des 2 corrections (programmatique)

> Généré par `scripts/verify_fix.ts` (PizZip / OOXML). Date : 2026-06-15.
> Fichier : `data/output/v1_with_template_fixed.docx` — 13385.4 Ko.

| Verdict | Critère | Détail |
|---|---|---|
| ✅ OK | Image chien (image8.jpeg) absente du média | absente |
| ✅ OK | Plus de relation vers image8.jpeg | aucune |
| ✅ OK | Plus de référence rId12 (chien) dans document.xml | aucune |
| ✅ OK | Bandeau d'en-tête / titre présent (txbxContent) | 278 zone(s) de titre |
| ✅ OK | Couleur d'origine du texte des bandeaux préservée (pas de #1A1A1A forcé) | préservée |
| ✅ OK | Corps toujours forcé en sombre #1A1A1A (non-régression) | présent |
| ✅ OK | Fond gris #E5E5E5 conservé (non-régression) | présent |
| ✅ OK | Image d'en-tête image2.png conservée (non-régression) | présente |

## Verdict : **OK ✅ (8/8)**

### Note de portée (lisibilité de l'en-tête)
- Les **bandeaux de titre principaux** (« NOS AGENTS … » sur rectangle foncé) retrouvent leur
  texte clair d'origine → **lisibles** (correction de la régression « texte sombre sur fond
  foncé »).
- Le **fil d'Ariane** (« I. PRESENTATION / 1. NOTRE CATALOGUE … ») sur les pages dont l'image
  de fond a été retirée reste en texte clair sur fond gris (contraste réduit). Le corriger
  davantage impliquerait de toucher au retrait des images de fond (hors périmètre V1.1 :
  `cloneSpread` / fond gris verrouillés).

