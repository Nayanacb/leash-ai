# Leash

**A spending firewall for autonomous AI agents.** Leash sits between an AI agent and PayPal and decides, for every attempted purchase, whether to **ALLOW** it, **ESCALATE** it to a human, or **BLOCK** it — using a deterministic policy engine, AI-powered intent verification, and prompt-injection detection.

> **Sandbox only.** Leash refuses to start with anything other than PayPal Sandbox configuration. No real money moves.

The full design lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Status

| Phase | Scope                                                                         | State    |
| ----- | ----------------------------------------------------------------------------- | -------- |
| 1     | Architecture                                                                  | Done     |
| 2     | Foundations: monorepo, schema, config + sandbox guard, logging, health, shell | Done     |
| 3     | Identity & setup: auth, agents + API keys, merchants, tasks, audit log        | Done     |
| 4+    | Policy engine, evaluation, approvals, PayPal, webhooks, refunds               | Upcoming |

## Repository layout

```
apps/server       Express + TypeScript API, Prisma (PostgreSQL)
apps/web          React + TypeScript + Tailwind dashboard (Vite)
packages/shared   Zod schemas, enums and money helpers used by both
docs/             Architecture
docker-compose.yml  Local PostgreSQL 16
```

## Prerequisites (macOS)

- **Node.js 22.18+** (`.nvmrc` pins 22): `nvm install && nvm use`, or `brew install node@22`
- **Docker Desktop** (or OrbStack) running, for PostgreSQL

## Getting started

```bash
npm install                                   # also generates the Prisma client
cp apps/server/.env.example apps/server/.env  # local config; no secrets needed yet
npm run db:up                                 # start Postgres on localhost:5433
npm run db:migrate                            # apply migrations
npm run dev                                   # API on :4000, dashboard on :5173
```

Open <http://localhost:5173>. The overview page shows API, database and PayPal-environment status.

## Scripts (run from the repo root)

| Command                     | What it does                                                        |
| --------------------------- | ------------------------------------------------------------------- |
| `npm run dev`               | Server (tsx watch) and web (Vite) together                          |
| `npm run build`             | Production builds of server (tsup) and web (Vite)                   |
| `npm run typecheck`         | TypeScript across all workspaces                                    |
| `npm run lint`              | ESLint, including architecture boundary rules                       |
| `npm run format`            | Prettier                                                            |
| `npm test`                  | Unit tests (no database needed)                                     |
| `npm run test:integration`  | Integration tests against the `leash_test` database (needs `db:up`) |
| `npm run db:up` / `db:down` | Start / stop Postgres                                               |
| `npm run db:migrate`        | Apply migrations (creates new ones after schema changes)            |

## APIs

- **Dashboard API** — `/api/v1`, session cookie (httpOnly, SameSite=Strict) plus an `X-CSRF-Token` header on every state-changing request. JSON bodies only.
- **Agent API** — `/api/agent/v1`, `Authorization: Bearer lsh_…`. Read-only access to the agent's own tasks; agents can never create or modify a task.

## Configuration

All server configuration is validated at startup (`apps/server/src/config/env.ts`). See [`apps/server/.env.example`](apps/server/.env.example) for every variable. Highlights:

- `PAYPAL_ENV` must be `sandbox`; any `PAYPAL_*` variable referencing a live PayPal host is rejected.
- `SANDBOX_MAX_TRANSACTION_MINOR` defaults to `50000` ($500) and cannot be raised above it.
- Anthropic model IDs (`LLM_MODEL_POLICY_COMPILER`, `LLM_MODEL_CLASSIFIER`) are configuration, not code. They are not needed until Phase 4.
- PayPal sandbox credentials are not needed until Phase 7. They live only in the server's environment.
