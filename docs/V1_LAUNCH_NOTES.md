# V1 — Notes de démarrage de la stack GSS-new

> Phase 1. Date : 2026-06-14. Branche : `feat/v1-template-refonte`.

## Accès (stack en cours d'exécution)

| Service | URL | Statut |
|---|---|---|
| **Backend API** | http://localhost:8000 | ✅ `GET /api/health` → `{"status":"ok"}` (200) |
| **Frontend (Next.js)** | http://localhost:3002 | ✅ 200 |

> ⚠️ Le frontend a basculé sur **3002** car les ports **3000** et **3001** étaient déjà
> occupés par d'autres process Node. Pour forcer le port 3000, libère-le d'abord
> (`lsof -nP -iTCP:3000 -sTCP:LISTEN`) ou lance `npm run dev -- -p 3000`.
>
> Le backend n'expose pas de route `/` (404 attendu) : toutes les routes sont sous `/api`
> (ex. `/api/health`). C'est normal.

## Architecture

- Backend : [gss-ao/backend](../gss-ao/backend) — Express + TypeScript, port `PORT || 8000`.
  - Dev : `nodemon` + `ts-node` sur `src/main.ts`. Routes préfixées `/api`.
- Frontend : [gss-ao/frontend](../gss-ao/frontend) — Next.js 14.

## Commandes pour ré-ouvrir

```bash
# Depuis la racine du repo
cd gss-ao

# Option 1 — les deux en parallèle (concurrently)
npm run dev

# Option 2 — séparément (logs dédiés)
cd backend  && npm run dev   # http://localhost:8000  (API sous /api)
cd frontend && npm run dev   # http://localhost:3000 (ou 3001/3002 si occupé)
```

## Dépendances

Déjà installées (`node_modules` présents pour backend, frontend et racine `gss-ao`).
Réinstallation si besoin : `cd gss-ao && npm run install:all`.

## Vérification rapide

```bash
curl -s http://localhost:8000/api/health           # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/   # 200
```
