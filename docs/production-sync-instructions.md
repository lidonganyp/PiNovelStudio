# Production Sync Instructions

## Current production application

Production must deploy the new TypeScript platform under `platform/`.

- Frontend: `platform/apps/web` (Vue + Vite)
- API: `platform/apps/api` (NestJS)
- Generation runtime: `platform/services/novel-runtime`
- Production topology: `platform/docker-compose.yml`
- Browser entry: `/` (the web application serves the workbench routes)

## Mandatory deployment rule

Do not deploy or start the legacy `sub2api/` application for the PiNovelStudio
product. The `sub2api/` directory is retained only as historical integration
material and must not be used as the production frontend, API, gateway, or
runtime source.

The production sync target is the GitHub `main` branch of this repository. A
deployment must build from the same commit for both the platform services and
the PiNovelStudio extension:

```text
PiNovelStudio commit
  -> npm run build:prod
  -> cd platform
  -> pnpm install --frozen-lockfile
  -> pnpm --filter @platform/web build
  -> pnpm --filter @platform/api build
  -> docker compose build
  -> docker compose up -d
```

The production API is the only public application service. The web frontend is
served by the API image in production; `novel-runtime` remains an internal
service and must not be exposed directly.

## Verification after sync

1. `GET /api/health` returns HTTP 200.
2. The web root and `/projects/:id/workbench` load from the new platform web
   application.
3. The running runtime reports the six PiNovelStudio tools from the current
   `dist/index.js` build.
4. No production process, compose service, reverse-proxy route, or deployment
   script points at `sub2api/`.

If a deployment still references `sub2api`, stop that deployment and resync
from this repository's `platform/` services before accepting production
traffic.
