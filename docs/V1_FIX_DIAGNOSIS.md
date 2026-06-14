# V1.1 — Diagnostic : header invisible + image chien

> Branche : `feat/v1-fix-header-and-dog-image`. Phase 1. Date : 2026-06-14.
> Correction ciblée suite à revue visuelle V1 (PR #4). Périmètre strict (2 points).

## 1. Image « chien » identifiée

| Attribut | Valeur |
|---|---|
| Fichier média | **`word/media/image8.jpeg`** (154 Ko) |
| rId (relation) | **`rId12`** (`document.xml.rels` → `media/image8.jpeg`) |
| Contenu | Photo **agent + chien berger allemand** (page 5 « I. PRESENTATION / 1. NOTRE CATALOGUE DE PRESTATIONS », bloc « NOS AGENTS CYNOPHILES ») |
| Références dans `document.xml` | **2** : 1 `r:embed="rId12"` (DrawingML, branche `mc:Choice`) + 1 `r:id="rId12"` (VML, branche `mc:Fallback`) |
| Unicité | `image8.jpeg` n'est ciblé que par `rId12` ; `rId12` n'est utilisé que pour cette image |

Structure : le bloc est un `<w:r>` contenant un `<mc:AlternateContent>` (Choice = `<w:drawing>` avec un `<wpg:wgp>` groupant **1** `<pic:pic>` = chien + **2** `<wps:wsp>` = bande sombre + libellé « NOS AGENTS CYNOPHILES » ; Fallback = `<w:pict>` VML équivalent). **Seule image du bloc = le chien.**

### Ligne XML à supprimer (extrait)
Le **run `<w:r>`** englobant le `<mc:AlternateContent>` qui référence `rId12` (les deux branches Choice/Fallback d'un coup). On le repère via les rIds résolus depuis `document.xml.rels` pour `image8.jpeg`, puis on remonte au `<w:r>` parent.

## 2. Diagnostic « header invisible »

Le forçage de couleur `#1A1A1A` est dans [memoire_generator.ts](../gss-ao/backend/src/generation/memoire_generator.ts) :
- Constante `DUP_TEXT_COLOR = '1A1A1A'` (ligne ~416)
- Fonction `forceTextColor(paras, color)` (ligne ~268)
- Appels dans `cloneSpread` : `forceTextColor(newHeading, DUP_TEXT_COLOR)` (**ligne ~311**) et `forceTextColor(newBody, DUP_TEXT_COLOR)` (ligne ~394)

**Cause** : `forceTextColor(newHeading, …)` force AUSSI le texte des **bandeaux de titre** (`txbxContent`, ex. « I. PRESENTATION », « 1. NOTRE CATALOGUE… ») en sombre. Or ces bandeaux ont un fond **foncé** → texte sombre sur fond foncé = **invisible**. Les pages où ça « marche » sont les pages maître (non clonées, non re-colorées).

**Correctif** : dans `forceTextColor`, **épargner les runs situés dans un `txbxContent`** (titre/bandeau). Le corps (`newBody`) n'a pas de `txbxContent` → toujours forcé en sombre (lisible sur fond gris). cloneSpread **n'est pas modifié** (seul le helper change).

## 3. Plan d'attaque Phase 2 (chirurgical, 2 modifs)

1. **`forceTextColor`** : ajouter `if (getParentWithLocalName(r, 'txbxContent')) return;` → préserve la couleur d'origine (claire) des bandeaux d'en-tête.
2. **`removeDogImageReferences(doc, dogRids)`** : retire le `<w:r>` englobant chaque référence à `image8.jpeg` (résolue depuis les rels) ; appelé dans `assembleFromSections` (Mode A, branche `refonte`). Purge aussi la relation `rId12` et le fichier `word/media/image8.jpeg` (gain de poids). Logge le nombre de références retirées.

### Périmètre / garde-fous
- Mode B (no-template), `BACKGROUND_COLOR` `#E5E5E5`, `cloneSpread`, les 31 images groupées (behindDoc + titre) et les tests existants : **non touchés**.
- Seule image retirée = `image8.jpeg` (chien), identifiée avec certitude (rendu visuel + rId unique).
