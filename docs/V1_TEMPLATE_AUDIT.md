# V1 — Audit du template DOCX et de l'architecture TypeScript

> Branche : `feat/v1-template-refonte` — Phase 1 (audit). Date : 2026-06-14.

## 1. Architecture identifiée

Le rewrite TypeScript vit dans [gss-ao/](../gss-ao/). Deux sous-projets :

| Sous-projet | Rôle | Stack |
|---|---|---|
| [gss-ao/backend](../gss-ao/backend) | Parseurs DCE, RAG, **génération du Mémoire Technique** | Node + Express + TypeScript, `vitest` |
| [gss-ao/frontend](../gss-ao/frontend) | SaaS interne (Next.js), pilotage de la génération | Next 14, React, `docx`/`jszip` côté client |

### Génération du Mémoire Technique
Tout est centralisé dans [memoire_generator.ts](../gss-ao/backend/src/generation/memoire_generator.ts) (classe `MemoireGenerator`). Deux chaînes coexistent :

1. **Mode A — « avec cadre / template »** : `generate(dossierId)`
   - Charge un `.docx` (cadre imposé par l'acheteur, sinon le mémoire GSS maître `Template/Mémoire technique/AO RNE.docx`).
   - Parse `word/document.xml` en DOM (`@xmldom/xmldom`), détecte les champs à remplir (pointillés, cellules vides, cases à cocher), les remplit via OpenAI, re-sérialise.

2. **Mode B — « sans cadre imposé » (réponse libre)** : `assembleFromSections()` / `exportFromSectionsMap()`
   - **Ne touche pas** au DOM d'AO RNE (le re-sérialiser dégrade sa maquette).
   - **Construit un `word/document.xml` NEUF** par concaténation de chaînes XML (`runX`/`paraX`/`markdownToParagraphsX`), puis le réinjecte dans le ZIP d'AO RNE (pour récupérer styles/polices/thème valides).
   - État actuel : fond **anthracite** `#494545`, texte crème, **suppression de TOUTES les images** (`word/media/*`) et de leurs relations.

### Librairies DOCX utilisées
| Lib | Où | Usage |
|---|---|---|
| `pizzip` | backend | ouverture/écriture du ZIP DOCX |
| `@xmldom/xmldom` | backend | parse/sérialise `document.xml` (DOMParser/XMLSerializer) |
| `docxtemplater` | backend (dép.) | non utilisé par le générateur actuel |
| `docx`, `jszip`, `docx-preview` | frontend | aperçu / export côté client |

### Routes API concernées
[routes.ts](../gss-ao/backend/src/api/routes.ts) : `POST /generate` (Mode A), `POST .../assemble` et `POST /export-docx` → `exportFromSectionsMap` (Mode B).

## 2. Inventaire du template `Template/Mémoire technique/AO RNE.docx`

- **Taille** : ~18 Mo. **233 entrées** dont **221 images** dans `word/media/`.
- `word/document.xml` = **5,0 Mo** (toute la maquette est inline, y compris la « page de garde »).
- **Aucun fichier `word/header*.xml` / `footer*.xml`** : il n'y a pas de section d'en-tête Word. L'identité visuelle (fond, bandeau) est obtenue par des **images pleine page ancrées** (`<wp:anchor behindDoc="1">`), pas par un `<w:background>`.
- **Aucun `<w:background>`** dans le document d'origine.

### Images clés de la page de garde (résolues via `word/_rels/document.xml.rels`)
| rId | Fichier | Taille | Rôle | Verdict |
|---|---|---|---|---|
| rId5 | `image1.png` | 2,25 Mo | Photo **pleine page** (cityscape Rouen) en fond de couverture | décoratif |
| **rId6** | **`image2.png`** | **3 Ko** | **Bandeau/logo « GSS » en haut de page (titre)** | **= image d'en-tête à conserver** |
| rId7 | `image3.jpeg` | 86 Ko | Visuel bas de couverture | décoratif |
| rId8 | `image4.png` | 57 Ko | Logo secondaire | décoratif |
| rId10 | `image6.png` | 890 Ko | Grand visuel | décoratif |
| … | image5, image7→image221 | ~15 Mo cumulés | Photos/pictos répétés sur les pages dupliquées | décoratifs / inutiles |

→ **Header identifié = `word/media/image2.png` (rId6)** : bandeau « GSS » porteur du titre.
→ **220 images décoratives** (image1, image3 → image221) alourdissent le fichier sans valeur structurelle dans une génération propre.

## 3. Choix de stratégie (Phase 2)

**Stratégie A — manipulation directe ZIP + XML** (retenue). Justification :
- Le template est trop complexe (5 Mo de XML, 221 images, group shapes VML) pour une reconstruction fidèle via `docx` npm.
- Le Mode B **construit déjà** son `document.xml` à la main et réutilise le ZIP d'AO RNE → on reste dans ce paradigme, qui est exactement « Stratégie A ».

### Plan d'action Phase 2 (sur `assembleFromSections`)
1. **Fond gris uniforme** : remplacer `COL_BG` anthracite `494545` par un **gris clair `E5E5E5`** (constante `BACKGROUND_COLOR`), et **basculer la palette en thème clair** (titres/texte foncés) pour garder la lisibilité.
2. **Conserver l'image d'en-tête** : créer un vrai `word/header1.xml` référençant **`image2.png`**, l'enregistrer dans `[Content_Types].xml` + `word/_rels/header1.xml.rels`, et ajouter `<w:headerReference w:type="default">` dans le `<w:sectPr>` → bandeau GSS répété sur **chaque page**.
3. **Supprimer les images inutiles des pages dupliquées** : ne **garder que `image2.png`**, retirer les 220 autres médias et leurs relations (conservées dans le `.docx` source pour revert).
4. **Tests** `tests/template_refonte.test.ts` (vitest) : fond gris présent, header image présent + référencé, médias décoratifs absents, DOCX relisible via PizZip.
5. **Builder « sans template »** (`assembleFromSections(..., { noTemplate: true })`) pour la comparaison Phase 3/4 : DOCX nu (styles Word par défaut, pas de fond, pas d'image, pas de page de garde).

### Garde-fous
- `COL_*`/`SZ_*` ne sont utilisés que par le Mode B → **aucune régression sur le Mode A**.
- Si le fond gris casse le rendu → repli `#FFFFFF`. Si l'ajout du header corrompt le ZIP → revert header, signaler.

> Note : il n'existe **aucun test** dans le projet à ce stade (`vitest` configuré mais aucun `*.test.ts` hors `node_modules`). « Tests existants verts » = ne pas casser le build TS.
