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
| 4     | Policy compiler, deterministic engine, budget ledger, policy review UI        | Done     |
| 5     | Purchase requests, injection + intent checks, decision combiner, transactions | Done     |
| 6+    | Human approval UI, PayPal checkout, webhooks, refunds                         | Upcoming |

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
- **Agent API** — `/api/agent/v1`, `Authorization: Bearer lsh_…`. Read-only access to the agent's own tasks (agents can never create or modify a task), plus purchase requests:

```bash
curl -s http://localhost:4000/api/agent/v1/purchase-requests \
  -H "Authorization: Bearer $LEASH_AGENT_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"…","merchantId":"…","amount":{"currency":"USD","value":"18.99"},
       "item":{"description":"USB-C cable, 2 m","quantity":1},
       "justification":"Cheapest 2 m cable from an allowed merchant",
       "sourceContext":[{"kind":"web_page","url":"https://shop.example/cable","content":"…"}]}'
```

The response is `{ id, status, decision: ALLOW|ESCALATE|BLOCK, reasonCodes, approvalExpiresAt, authorizationExpiresAt }`. Retrying with the same `Idempotency-Key` returns the same purchase. `GET /purchase-requests/:id` polls; `POST /purchase-requests/:id/cancel` withdraws a pending or authorized purchase. No money moves yet (PayPal arrives in Phase 7).

## Configuration

All server configuration is validated at startup (`apps/server/src/config/env.ts`). See [`apps/server/.env.example`](apps/server/.env.example) for every variable. Highlights:

- `PAYPAL_ENV` must be `sandbox`; any `PAYPAL_*` variable referencing a live PayPal host is rejected.
- `SANDBOX_MAX_TRANSACTION_MINOR` defaults to `50000` ($500) and cannot be raised above it.
- Anthropic model IDs are configuration, never code. See below.
- PayPal sandbox credentials are not needed until Phase 7. They live only in the server's environment.

### Anthropic (policy compilation)

Only needed to translate natural-language policies. Everything else — including enforcing an already-confirmed policy — works without it. Set these in `apps/server/.env` (never commit that file):

| Variable                         | Required        | Meaning                                                                                                                                           |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`              | Yes, to compile | Server-side only; never sent to agents or the browser.                                                                                            |
| `LLM_MODEL_POLICY_COMPILER`      | Yes, to compile | Exact model ID (no default). Must support structured outputs. Look IDs up in Anthropic's model docs or `GET https://api.anthropic.com/v1/models`. |
| `LLM_MODEL_CLASSIFIER`           | Phase 5         | Model ID for intent verification and injection classification.                                                                                    |
| `LLM_POLICY_COMPILER_TIMEOUT_MS` | No (60000)      | Request timeout, 5000–300000.                                                                                                                     |
| `LLM_POLICY_COMPILER_EFFORT`     | No              | `low`…`max`. Leave empty unless the chosen model supports the `effort` parameter.                                                                 |

Without a key, the Policies page explains that compilation isn't configured (HTTP 503 `LLM_NOT_CONFIGURED`) and opens the **JSON** editor instead: you can write the policy JSON yourself, with no AI involved. Either way the result is a draft: nothing is enforced until you review and confirm it with your password.

To verify the live Anthropic integration once the key and model are set (one request, fixed sample text, the key is never printed):

```bash
npm run llm:smoke -w @leash/server
```

Add `-- --classifier` to check the injection classifier and intent verifier instead (two benign and two adversarial samples).

Exit code 0 means the API accepted the structured-output request and the response passed strict validation; 1 means it failed (the reason is printed); 2 means it isn't configured.

### Reservation recovery

| Variable                             | Default       | Meaning                                                                                      |
| ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------- |
| `EVALUATION_TIMEOUT_SECONDS`         | 120 (30–3600) | A purchase still being evaluated after this long is expired and its reserved funds released. |
| `RESERVATION_SWEEP_INTERVAL_SECONDS` | 30 (5–3600)   | How often the server runs that sweep (it also runs once at startup).                         |
