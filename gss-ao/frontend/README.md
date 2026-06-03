# Frontend GSS-AO — maquette interactive (mockup v1)

Maquette navigable des 6 écrans du produit (Next.js 14 App Router + Tailwind).
**Statique** : pas de backend, pas d'auth, pas d'appel API — les données sont
figées dans `lib/mock-data.ts` (cas Université de Rouen Normandie 2026-08).

## Lancer en local

```bash
cd gss-ao/frontend
npm install      # une seule fois (deps légères : next/react/tailwind/lucide)
npm run dev      # démarre sur http://localhost:3000
```

> Astuce machine modeste : `npm install` est l'étape la plus gourmande. La
> lancer seule, sans autre application lourde ouverte. Le serveur `npm run dev`
> est ensuite léger.

## Écrans (URLs)

| # | Écran | URL |
|---|-------|-----|
| 1 | Liste des dossiers | `http://localhost:3000/` |
| 2 | Upload DCE | `http://localhost:3000/dossiers/nouveau` |
| 3 | Synthèse DCE | `http://localhost:3000/dossiers/rouen-2026-08` |
| 4 | Check-list conformité | `http://localhost:3000/dossiers/rouen-2026-08/conformite` |
| 5 | **Éditeur mémoire technique** | `http://localhost:3000/dossiers/rouen-2026-08/memoire` |
| 6 | Export final | `http://localhost:3000/dossiers/rouen-2026-08/export` |

## Design

- Palette slate + accent **indigo** (`--primary`), via CSS variables.
- **Dark-ready** : tokens définis pour `:root` et `.dark` ; activer plus tard en
  ajoutant `className="dark"` sur `<html>` (aucun refactor).
- Composants UI auto-portés (`components/ui.tsx`) stylés comme shadcn/ui — mêmes
  tokens, remplaçables par le vrai shadcn ultérieurement. Icônes : lucide-react.
