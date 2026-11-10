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
| 6     | Human approval: queue, approve/reject with step-up + snapshot hash, expiry    | Done     |
| 7     | PayPal sandbox checkout: order, buyer approval, verify-then-capture           | Done     |
| 8+    | Webhooks, refunds                                                             | Upcoming |

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

The response is `{ id, status, decision: ALLOW|ESCALATE|BLOCK, reasonCodes, approvalExpiresAt, authorizationExpiresAt }`. Retrying with the same `Idempotency-Key` returns the same purchase. `GET /purchase-requests/:id` polls; `POST /purchase-requests/:id/cancel` withdraws a purchase that hasn’t started capturing. Statuses after authorization: `ORDER_CREATED` → `CAPTURING` → `CAPTURED` (reason `PAID`), or `PAYMENT_FAILED` / `EXPIRED`. Agents never receive PayPal links, order IDs or credentials.

### Human approval (ESCALATE)

An ESCALATE decision creates an approval and keeps the funds held. It appears on the **Approvals** page (the navigation badge shows how many are waiting) and on the transaction's detail page.

- **Approve** shows the amount, the merchant, the PayPal account that would be paid and the item, then asks for your password if you haven't confirmed it in the last `STEP_UP_WINDOW_MINUTES` (default 5). The request carries the snapshot hash of what you saw. Before authorizing, the server re-checks the current policy, budget and task; if they would now block the purchase, approval is refused (409 `POLICY_NOW_BLOCKS`). If the purchase or the merchant's payee changed since, it is refused too (409 `SNAPSHOT_MISMATCH` / `SNAPSHOT_STALE`). On success the purchase is `AUTHORIZED` for `AUTHORIZATION_TTL_MINUTES`.
- **Reject** needs no password; the held funds are released immediately.
- Unanswered approvals expire after `APPROVAL_TTL_MINUTES` and release their funds. Nothing is ever approved automatically, and BLOCK decisions can't be approved.
- The agent learns the outcome by polling `GET /purchase-requests/:id`: `AUTHORIZED` with reason `APPROVED`, or `REJECTED` with reason `REJECTED`.

Dashboard endpoints: `GET /api/v1/approvals?status=PENDING|APPROVED|REJECTED|EXPIRED|CANCELLED`, `POST /api/v1/approvals/:id/approve` (`{ snapshotHash, note? }`; needs a recent `POST /api/v1/auth/step-up`), `POST /api/v1/approvals/:id/reject` (`{ note? }`).

### Payments (PayPal sandbox)

An authorized purchase (ALLOW, or ESCALATE + your approval) shows **Pay with PayPal (sandbox)** on its detail page. Leash creates the PayPal order from the stored purchase (amount, currency, the payee fixed when Leash decided, transaction ID), and sends **you** — never the agent — to PayPal's sandbox to approve it with a sandbox buyer account. PayPal returns you to `/transactions/:id/paypal-return`; that page asks the server to finish, and the server:

1. ignores everything in the redirect and fetches the stored order from PayPal itself;
2. requires it to be `APPROVED` and to match exactly: amount, currency, payee, `custom_id`/`invoice_id` (the transaction ID);
3. checks the authorization deadline (`AUTHORIZATION_TTL_MINUTES`, default 30, covers the whole checkout), that the merchant's PayPal account is unchanged, and re-runs your current policy, task and budget;
4. captures once (stable `PayPal-Request-Id`) and verifies the capture.

A mismatch, a changed payee, or a policy that now blocks → `PAYMENT_FAILED`, nothing captured, funds released once. A pending capture or a lost response stays `CAPTURING`; the background sweep reads PayPal's state first and only then re-sends the capture with the same request ID. Leaving PayPal without paying keeps the order; you can continue until the deadline.

Setup (sandbox only): create a sandbox REST app at developer.paypal.com and set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in `apps/server/.env`; register merchants with sandbox **Business** account emails; pay with a sandbox **Personal** account. Check the credentials (creates one 1.00 USD order, never captures it, never prints secrets):

```bash
npm run paypal:smoke -w @leash/server -- --payee <sandbox business email>
```

Dashboard endpoints: `POST /api/v1/transactions/:id/checkout` → `{ status: "REDIRECT", approveUrl }` or `{ status: "APPROVED" }`; `POST /api/v1/transactions/:id/checkout/complete` → the transaction.

## Configuration

All server configuration is validated at startup (`apps/server/src/config/env.ts`). See [`apps/server/.env.example`](apps/server/.env.example) for every variable. Highlights:

- `PAYPAL_ENV` must be `sandbox`; any `PAYPAL_*` variable referencing a live PayPal host is rejected.
- `SANDBOX_MAX_TRANSACTION_MINOR` defaults to `50000` ($500) and cannot be raised above it.
- Anthropic model IDs are configuration, never code. See below.
- PayPal sandbox credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) live only in the server's environment. See **Payments** below.

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
