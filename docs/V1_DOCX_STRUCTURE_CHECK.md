# V1 — Vérification programmatique de la structure des DOCX

> Phase 2 — généré par `scripts/verify_v1_docx.ts` (PizZip / OOXML). Date : 2026-06-14.

## Fichiers vérifiés
- `data/output/v1_with_template.docx` — 16.1 Ko (Mode A, template refondu)
- `data/output/v1_no_template.docx` — 2.5 Ko (Mode B, nu)

## Mode A — template refondu (assertions de conformité)

| Verdict | Assertion | Détail |
|---|---|---|
| ✅ OK | Ouverture du DOCX (zip valide) | 15 parts |
| ✅ OK | Fond gris `<w:background w:color="E5E5E5"/>` | présent |
| ✅ OK | Affichage du fond `displayBackgroundShape` | activé |
| ✅ OK | En-tête `word/header1.xml` présent | présent |
| ✅ OK | header1.xml référence une image (`r:embed`) | r:embed="rId1" |
| ✅ OK | header1.xml.rels → image2.png | média/image2.png |
| ✅ OK | Référence d'en-tête sur sectPr `<w:headerReference>` | 1 référence(s) |
| ✅ OK | Une seule image réelle dans word/media/ | 1 image(s) : image2.png |

## Mode B — sans template (assertions inverses)

| Verdict | Assertion | Détail |
|---|---|---|
| ✅ OK | Ouverture du DOCX (zip valide) | 4 parts |
| ✅ OK | PAS de fond gris | aucun <w:background> |
| ✅ OK | PAS de displayBackgroundShape | absent |
| ✅ OK | PAS d'en-tête header1.xml | absent |
| ✅ OK | PAS de headerReference | absent |
| ✅ OK | Aucune image dans word/media/ | 0 image(s) |

## Verdict global

**Conformité à la commande tuteur : OUI** — fond gris uniforme #E5E5E5 ✅, bandeau d'en-tête conservé sur chaque page ✅, images décoratives retirées (1 seule image conservée) ✅. Génération nue dépourvue de fond/header/images comme attendu ✅.

