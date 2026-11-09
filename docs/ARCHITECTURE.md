# Leash — System Architecture

> **Status:** Approved (Phase 1). This document is the source of truth for the design.
> Changes to it should be made deliberately, in their own commits, before the code that depends on them.

Leash is a **spending firewall for autonomous AI agents**. It sits between an AI agent and PayPal and decides, for every attempted purchase, one of:

- **ALLOW** — the purchase is authorized by Leash and may proceed to payment.
- **ESCALATE** — a human must approve in the Leash dashboard before anything else happens.
- **BLOCK** — the purchase is refused. Final.

It does this with three security layers, combined by deterministic code:

1. A **deterministic spending policy engine** enforcing user-confirmed rules.
2. An **AI-powered intent verifier** checking that the purchase matches the user's original instruction.
3. A **prompt-injection detector** looking for malicious instructions in external content.

---

## Table of contents

0. [Approved decisions](#0-approved-decisions)
1. [Invariants](#1-invariants)
2. [System architecture](#2-system-architecture)
3. [Folder structure](#3-folder-structure)
4. [Database schema](#4-database-schema)
5. [REST API](#5-rest-api)
6. [Transaction authorization lifecycle](#6-transaction-authorization-lifecycle)
7. [Security threats and mitigations](#7-security-threats-and-mitigations)
8. [Implementation roadmap](#8-implementation-roadmap)

---

## 0. Approved decisions

| Topic | Decision |
|---|---|
| PayPal mode | **PayPal Checkout (Orders v2 with buyer approval)** for the MVP. **Sandbox only.** The payment module is designed behind a `PaymentProvider` interface so **PayPal Vault** (saved payment method, server-side capture for genuinely autonomous ALLOW payments) can be added later — and only with explicit, revocable user consent. |
| Users | **Multi-user** from day one. Every user-owned row carries `userId`; every query is scoped by it. |
| AI models | **Configurable via environment variables; no model IDs hard-coded in source.** `LLM_MODEL_POLICY_COMPILER` (stronger model) and `LLM_MODEL_CLASSIFIER` (cost-effective model, used for intent verification and injection classification). Startup validates both are set (and optionally verifies them against the Anthropic Models API). |
| Approval timeout | **60 minutes** (default; per-policy override allowed, bounded by config). |
| Authorization timeout | **30 minutes** — how long an AUTHORIZED transaction may wait for PayPal checkout to complete. |
| Sandbox ceiling | **$500.00 per transaction** (`50000` minor units). A global hard limit no policy can exceed. |

### Two separate approval checkpoints

Leash has **two independent checkpoints** and they must never be confused:

| | **Leash human approval** | **PayPal buyer approval** |
|---|---|---|
| What it is | The Leash user reviews an ESCALATED purchase in the Leash dashboard and approves or rejects it. | The PayPal account holder approves a specific PayPal order on PayPal's checkout page. |
| What it proves | The purchase is acceptable under the user's judgement, despite tripping an ESCALATE rule. | The PayPal account holder consented to PayPal paying *this order*. |
| What it does **not** prove | Nothing about PayPal. | **Nothing about Leash policy.** PayPal does not know Leash's rules, budgets, task intent, or injection signals. |
| When it happens | Only for ESCALATE decisions, *before* a PayPal order exists. | For every payment in Checkout mode, *after* Leash has authorized the transaction. |
| Who can trigger it | Authenticated Leash user, with step-up re-authentication. | Whoever logs into PayPal on the approval page. |

Capture requires **both** that the transaction is AUTHORIZED in Leash (via ALLOW, or ESCALATE + Leash human approval) **and** that the PayPal order — fetched server-side — is APPROVED and matches the authorized values exactly. Neither checkpoint substitutes for the other.

---

## 1. Invariants

| # | Invariant |
|---|---|
| I1 | The agent only ever holds a **Leash agent API key**. PayPal client ID/secret, PayPal OAuth tokens, and PayPal approval URLs stay on the backend. Payment credentials exist **only** in the server's environment and the payment module. |
| I2 | **Deterministic code has final authority.** LLM outputs are *signals* that can only make a decision stricter (ALLOW → ESCALATE → BLOCK), never looser. A policy BLOCK cannot be overridden by anything, including human approval. |
| I3 | **Money moves only if** the transaction is AUTHORIZED in Leash **and** the PayPal order, fetched server-side, matches the authorized amount, currency, payee and transaction ID. PayPal buyer approval is *necessary but never sufficient*. |
| I4 | **Fail closed.** LLM timeout, refusal, truncation, or schema-invalid output → ESCALATE. Ambiguous PayPal state → no capture. |
| I5 | **Sandbox only.** The PayPal client has only the sandbox base URL in code; config schema accepts only `PAYPAL_ENV=sandbox`; the server refuses to start otherwise. |
| I6 | Every state change is written to an **append-only, hash-chained audit log**, consistent under concurrent writes. |
| I7 | **Strict separation** between the AI evaluation pipeline and the deterministic authorization engine (see §2.2). |

---

## 2. System architecture

```
 ┌─────────────┐ Leash agent key      ┌────────────────────────── Leash server (Express + TS) ───────────────────────────┐
 │  AI agent   │ ───────────────────▶ │ Agent API ──▶ Transaction service ──▶ Authorization engine (deterministic)       │
 │ (untrusted) │ ◀── decision/status ─│                                        ├─ Policy engine (pure)                   │
 └─────────────┘                      │                                        ├─ Budget ledger (locks + reservations)   │
                                      │                                        └─ Decision combiner (pure)               │
                                      │                                               ▲ signals only                     │
                                      │                                        AI evaluation pipeline (advisory)  ───────┼──▶ Anthropic API
                                      │                                        ├─ Injection detector (rules + LLM)       │
 ┌─────────────┐ session cookie+CSRF  │                                        └─ Intent verifier (LLM)                  │
 │ User: React │ ───────────────────▶ │ User API: policies · tasks · merchants · approvals · refunds · audit             │
 │  dashboard  │                      │ Payment service (only holder of PayPal creds) ───────────────────────────────────┼──▶ PayPal Sandbox
 └─────────────┘                      │ Webhook receiver (verify → dedupe → reconcile) ◀─────────────────────────────────┼─── PayPal webhooks
                                      │ Jobs (pg-boss): approval expiry · authorization expiry · reconciliation           │
                                      └────────────────────────────────────────┬──────────────────────────────────────────┘
                                                                               ▼
                                                                  PostgreSQL (Prisma)
```

### 2.1 Components

| Component | Responsibility | Trust |
|---|---|---|
| Agent API (`/api/agent/v1`) | Submit and poll purchase requests. The *only* surface an agent can reach. | Caller untrusted |
| User API (`/api/v1`) | Dashboard backend: auth, policies, tasks, merchants, approvals, refunds, audit. | Session + CSRF |
| Policy compiler | Natural language → Policy DSL via LLM. Output is a **draft** until the user confirms. | LLM, authoring-time only |
| Policy engine | Pure function `(rules, request, spendSnapshot) → ruleResults[]`. No I/O, no LLM. | Deterministic |
| Budget ledger | Reservations + per-user advisory lock so concurrent requests cannot jointly exceed limits. | Deterministic |
| Decision combiner | Pure function: policy results + AI signals → ALLOW/ESCALATE/BLOCK + reason codes. | Deterministic |
| Injection detector | Deterministic heuristics + LLM classifier over all agent-supplied text. | Advisory signal |
| Intent verifier | LLM compares the request with the user-authored task instruction. | Advisory signal |
| Payment service | Sole holder of PayPal credentials. Creates orders, verifies, captures, refunds. Behind a `PaymentProvider` interface (Checkout now, Vault later). | Backend only |
| Webhook receiver | Verifies PayPal signatures, dedupes, reconciles. Can never authorize. | Signature-verified |
| Jobs | pg-boss (Postgres-backed; no Redis): expiry and reconciliation. | Deterministic |
| Audit log | Append-only, hash-chained, serialized writes. | Deterministic |

### 2.2 Separation of AI evaluation and deterministic authorization

The codebase enforces this structurally, not just by convention:

- `modules/authorization/` (policy engine, budget ledger, decision combiner, state machine) **must not import** from `modules/evaluation/` or `llm/`. Enforced with an ESLint `no-restricted-imports` rule.
- The AI pipeline returns a plain, Zod-validated `AiSignals` value object (`{ injection: {...}, intent: {...} }`). The combiner consumes that value; it never calls an LLM, and the LLM never sees the combiner, policy thresholds, or any payment capability.
- The combiner's thresholds live in code/config. Neither the policy compiler nor any LLM can change them.
- The AI pipeline has **no tools**, no database handle, and no payment client.

### 2.3 Key concepts

- **Task (mandate).** The user's original instruction (e.g. "Buy a 2 m USB-C cable under $20"). Created **only by the user** in the dashboard; the agent references it by ID. Intent verification compares purchases against this. If the agent could submit its own "original instruction", intent verification would be meaningless.
- **Merchant registry.** Payees are PayPal sandbox business accounts registered by the user. The agent supplies a `merchantId`; the server resolves the payee. The agent can never supply a raw payee email. Unknown merchant → ESCALATE.
- **Policy compiler vs. policy engine.** The LLM is used only at authoring time to translate rules; the user confirms a deterministically-rendered summary; enforcement is pure code.
- **sourceContext.** External content the agent says it consumed (web pages, emails). It is **untrusted and potentially incomplete** — a compromised agent can omit or alter it. Injection detection over it is an **additional layer, not a guarantee**: it can raise suspicion (ESCALATE/BLOCK) but its silence never implies safety. Policy, task budget, merchant registry and intent checks do not depend on it.

### 2.4 LLM usage

- Anthropic TypeScript SDK, **server-side only**; `ANTHROPIC_API_KEY` lives only in server env.
- **Models are configured, not hard-coded:**
  - `LLM_MODEL_POLICY_COMPILER` — a stronger model, used rarely, at authoring time.
  - `LLM_MODEL_CLASSIFIER` — a cost-effective, low-latency model for intent verification and injection classification.
  - Optional startup check against the Anthropic Models API that the configured IDs exist.
- Structured outputs (JSON schema), re-validated with Zod. No tools. Untrusted text goes in the user turn inside explicit delimiters, never in the system prompt.
- Short timeouts (~8 s) for per-transaction calls. `stop_reason` of `refusal`/`max_tokens`, invalid output, or any error → **ESCALATE**.
- Every evaluation records model ID, prompt version, latency and raw output.

---

## 3. Folder structure

npm workspaces monorepo.

```
leash-ai/
├─ apps/
│  ├─ server/
│  │  ├─ prisma/                 schema.prisma · migrations/ · seed.ts
│  │  ├─ src/
│  │  │  ├─ index.ts             boot: config → db → http → jobs
│  │  │  ├─ app.ts               express wiring, helmet/CSP, routers
│  │  │  ├─ config/env.ts        Zod-validated env + sandbox guard
│  │  │  ├─ middleware/          requestId · sessionAuth · agentAuth · csrf · rateLimit · validate(zod) · errorHandler
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/             register/login/sessions/step-up
│  │  │  │  ├─ agents/           agents + hashed API keys
│  │  │  │  ├─ merchants/
│  │  │  │  ├─ tasks/
│  │  │  │  ├─ policies/         compiler.ts (LLM) · render.ts (DSL → English, deterministic)
│  │  │  │  ├─ authorization/    policyEngine.ts · combiner.ts · stateMachine.ts   ← deterministic, no LLM imports
│  │  │  │  ├─ budget/           ledger.ts (reservations, rolling windows, advisory locks)
│  │  │  │  ├─ evaluation/       injection/{heuristics,classifier}.ts · intent/verifier.ts · pipeline.ts  ← advisory
│  │  │  │  ├─ transactions/     service.ts · agent.routes.ts · user.routes.ts
│  │  │  │  ├─ approvals/
│  │  │  │  ├─ payments/         provider.ts (interface) · paypal/{client,checkout,refunds,verifyWebhook}.ts
│  │  │  │  ├─ webhooks/
│  │  │  │  └─ audit/            append-only writer · hash chain · verifier
│  │  │  ├─ llm/                 anthropic.ts · prompts/ (versioned) · output schemas
│  │  │  ├─ jobs/                expireApprovals · expireAuthorizations · reconcilePayments
│  │  │  └─ lib/                 money.ts · errors.ts · logger.ts (pino + redaction) · crypto.ts
│  │  └─ test/                   unit · integration (real Postgres) · adversarial/ (injection corpus)
│  └─ web/                       Vite + React + TS + Tailwind + React Router + TanStack Query
│     └─ src/
│        ├─ api/                 typed client + query hooks
│        ├─ components/ui/       tables, DecisionBadge, UntrustedText
│        ├─ features/            auth · dashboard · policies · tasks · agents · merchants
│        │                       transactions (list + timeline) · approvals (queue + step-up) · audit
│        └─ lib/                 money formatting
├─ packages/shared/              Zod schemas: API contracts, enums, Policy DSL, money helpers
├─ examples/demo-agent/          scripted agent incl. injection scenarios (later phase)
├─ docs/
├─ docker-compose.yml            Postgres
└─ .env.example
```

---

## 4. Database schema

Conventions: UUID primary keys; **money as integer minor units** (`amountMinor`) + ISO-4217 `currency` — never floats; `createdAt`/`updatedAt`; every user-owned row has `userId`.

| Model | Key fields | Notes |
|---|---|---|
| `User` | email (unique), passwordHash (argon2id) | Multi-user. |
| `Session` | userId, tokenHash (unique), expiresAt, stepUpAt | Opaque session tokens, hashed. |
| `Agent` | userId, name, status (ACTIVE/SUSPENDED/REVOKED) | |
| `AgentApiKey` | agentId, label?, prefix, keyHash (unique), lastUsedAt, expiresAt, revokedAt? | 256-bit random keys, SHA-256 hashed, shown once. Every key expires (7/30/90/365 days); max 5 active per agent. |
| `Merchant` | userId, displayName, paypalEmail, paypalMerchantId?, domain?, category, archivedAt? | unique (userId, paypalEmail). Archived instead of deleted (history references it); archived merchants can't be used in new tasks. |
| `PolicyVersion` | userId, version, sourceText, compiledRules (JSON), rulesHash, status, compilerModel, promptVersion, unmappedClauses, confirmedAt | unique (userId, version); partial unique index: one ACTIVE per user; immutable once ACTIVE. |
| `Task` | userId, agentId, instruction, budgetMinor, currency, allowedMerchantIds[], status, expiresAt | Created only by the user. |
| `Transaction` | userId, agentId, taskId, merchantId, policyVersionId, idempotencyKey, requestHash, amountMinor, currency, itemDescription, quantity, category, agentJustification, untrustedContext, status, decision, reasonCodes[], snapshotHash, authorizedAt, authorizationExpiresAt, paypalOrderId (unique), paypalCaptureId (unique), capturedMinor, refundedMinor, version | unique (agentId, idempotencyKey). |
| `Evaluation` | transactionId, layer (POLICY/INJECTION/INTENT), verdict, confidence, details, model, promptVersion, latencyMs, error | One row per layer per transaction. |
| `Approval` | transactionId (unique), status, snapshotHash, requestedAt, expiresAt, decidedAt, decidedByUserId, note | Leash human approval. |
| `LedgerEntry` | userId, transactionId, type (RESERVE/RELEASE/REFUND), amountMinor, currency | Append-only; source of truth for committed spend. |
| `Refund` | transactionId, idempotencyKey (unique), paypalRefundId (unique), amountMinor, currency, status, reason, requestedByUserId | User-initiated only. |
| `WebhookEvent` | paypalEventId (unique), eventType, resourceId, payload, verified, transactionId?, processedAt, error | Dedupe by event ID. |
| `AuditEvent` | seq (bigint, ordered), userId?, transactionId?, actorType, actorId?, action, data, prevHash, hash | Append-only (DB trigger blocks UPDATE/DELETE); hash-chained. |

**Committed spend** in a window = Σ RESERVE − Σ RELEASE − Σ REFUND for that user and currency. Reservations are written when a request passes the deterministic policy, so pending and authorized requests already count toward limits.

**Concurrency rules**

- **Spending:** every policy evaluation + reservation happens inside one DB transaction holding `pg_advisory_xact_lock(<per-user key>)`. Two concurrent requests for the same user serialize; the second sees the first's reservation.
- **Audit chain:** every append takes a global `pg_advisory_xact_lock(<audit key>)`, reads the last hash, computes the new one, and inserts — in the same transaction. The chain is linear even under concurrent writers. `seq` gives the canonical order.
- **State transitions:** compare-and-swap `UPDATE … WHERE id = ? AND status = <expected>`; zero rows updated = lost race = no-op/409.

**Audit chain details (implemented in Phase 3)**

- `hash = SHA-256("leash-audit-v1\n" + canonicalJSON({prevHash, id, userId, transactionId, actorType, actorId, action, data, createdAt}))`, with keys sorted recursively so the hash survives `jsonb` round-trips. The first event's `prevHash` is 64 zeros.
- Each append runs **inside the same DB transaction as the action it records**, so an action and its audit entry commit or roll back together.
- Verification recomputes every hash and link from genesis (or from a trusted anchor event). It detects modification, insertion, deletion and reordering. Removing the *newest* events is only detectable against an externally stored checkpoint (planned for Phase 9).
- Audit data never contains secrets: callers don't pass them, and the writer redacts secret-looking keys as a backstop.

Phase 2 ships the full schema and the initial migration; behaviour arrives in later phases.

---

## 5. REST API

### 5.1 Agent API — `/api/agent/v1`, `Authorization: Bearer lsh_…`

| Method | Path | Purpose |
|---|---|---|
| POST | `/purchase-requests` | Submit (requires `Idempotency-Key` header). |
| GET | `/purchase-requests/:id` | Poll decision/status. |
| POST | `/purchase-requests/:id/cancel` | Agent withdraws a pending/authorized request. |
| GET | `/tasks/:id` | Task status and remaining budget (no policy details). |

```jsonc
// POST /purchase-requests
{ "taskId": "…", "merchantId": "…",
  "amount": { "currency": "USD", "value": "18.99" },     // strict decimal → minor units
  "item": { "description": "USB-C cable 2m", "quantity": 1, "category": "electronics" },
  "justification": "…",                                    // untrusted
  "sourceContext": [{ "kind": "web_page", "url": "…", "content": "…" }] }  // untrusted, may be incomplete, size-capped
// → 201
{ "id": "…", "decision": "ESCALATE", "status": "PENDING_APPROVAL",
  "reasonCodes": ["REQUIRES_HUMAN_APPROVAL"], "expiresAt": "…" }
```

The agent receives only coarse reason codes — never thresholds or PayPal data.

### 5.2 User API — `/api/v1`, session cookie, CSRF token on mutations

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/step-up` |
| Agents | `GET/POST /agents` · `PATCH /agents/:id` · `POST /agents/:id/keys` · `DELETE /agents/:id/keys/:keyId` |
| Merchants | `GET/POST /merchants` · `PATCH /merchants/:id` |
| Policies | `POST /policies/compile` · `GET /policies/versions` · `GET /policies/versions/:id` · `POST /policies/versions/:id/confirm` (step-up) · `POST /policies/versions/:id/reject` · `GET /policies/active` · `POST /policies/simulate` |
| Tasks | `GET/POST /tasks` · `GET /tasks/:id` · `POST /tasks/:id/cancel` |
| Transactions | `GET /transactions` (filters) · `GET /transactions/:id` (with evaluations, approval, payments, refunds, audit) |
| Approvals | `GET /approvals?status=PENDING` · `POST /approvals/:id/approve` (step-up + `snapshotHash`) · `POST /approvals/:id/reject` |
| Payments | `POST /transactions/:id/checkout` (creates PayPal order; approval link returned to the **user**) · `GET /payments/paypal/return` · `GET /payments/paypal/cancel` |
| Refunds | `POST /transactions/:id/refunds` (`Idempotency-Key`) · `GET /transactions/:id/refunds` |
| Audit / stats | `GET /audit-events` · `GET /audit-events/verify` · `GET /stats/spend` |

### 5.3 Other

- `POST /api/webhooks/paypal` — unauthenticated, signature-verified, raw body.
- `GET /healthz` — liveness. `GET /readyz` — readiness (DB reachable).

---

## 6. Transaction authorization lifecycle

```
submit ─▶ EVALUATING ─BLOCK─────────────────────────────────▶ BLOCKED            (release reservation)
              │  └─ESCALATE─▶ PENDING_APPROVAL ─reject──────▶ REJECTED           (release)
              │                    │  └──timeout (60m)──────▶ EXPIRED            (release; never auto-approve)
              │ ALLOW        Leash human approval
              │              (step-up + snapshotHash + re-check)
              ▼                    ▼
          AUTHORIZED ◀─────────────┘ ──timeout (30m)──▶ EXPIRED (release)
              │ server creates PayPal order from stored, authorized values
              ▼
        ORDER_CREATED ──PayPal buyer approval (separate checkpoint)──▶ BUYER_APPROVED
                                                       │ server GETs order, verifies exact match, re-checks BLOCK rules
                                                       ▼
                                                   CAPTURING ──▶ CAPTURED ──▶ PARTIALLY_REFUNDED / REFUNDED / REVERSED
                                                       └───────▶ PAYMENT_FAILED (release)
```

### 6.1 Evaluation

1. Authenticate the agent key; Zod-validate; idempotency (same key + same body hash → return existing; same key + different body → 409).
2. Load task (ACTIVE, owned by this agent, unexpired), merchant, and ACTIVE policy version. No active policy → BLOCK.
3. **Deterministic authorization, part 1** — in one DB transaction holding the per-user advisory lock: compute spend snapshot, run the policy engine (including the $500 sandbox ceiling), write a RESERVE ledger entry if not BLOCKED, commit.
4. **AI evaluation pipeline (advisory)** — outside the lock, in parallel: injection heuristics (always), injection classifier and intent verifier (skipped if already BLOCK). Produces `AiSignals`.
5. **Deterministic authorization, part 2** — the decision combiner (first matching row wins):

| Condition | Result |
|---|---|
| Any policy rule with action BLOCK matched | **BLOCK** |
| High-severity heuristic hit, or classifier `malicious` with confidence ≥ 0.8 | **BLOCK** |
| Intent `mismatch` with confidence ≥ 0.8 | **BLOCK** |
| Any policy rule with action ESCALATE matched (incl. unknown merchant) | **ESCALATE** |
| Injection `suspicious`, or `malicious` below threshold | **ESCALATE** |
| Intent `partial`, `uncertain`, or `mismatch` below threshold | **ESCALATE** |
| Any AI layer errored, timed out, refused, or returned invalid output | **ESCALATE** |
| Otherwise | **ALLOW** |

A clean injection result **never** promotes a decision; it is only the absence of one reason to escalate.

### 6.2 Leash human approval (ESCALATE)

- `Approval` created with `expiresAt = now + 60 min`. The reservation stays held while pending.
- Dashboard shows: request, user-authored task instruction, merchant, every layer's verdict and reasons. Agent-written text is shown as plain text inside an **"Untrusted — written by the agent"** frame, with injection hits highlighted.
- Approve requires: valid session, CSRF token, **step-up re-authentication**, and the `snapshotHash` the UI displayed (approve-what-you-saw).
- Server, in one DB transaction: CAS the Approval (`PENDING` and unexpired), re-run deterministic BLOCK rules against current spend and current policy (→ 409 if now blocked), then CAS the transaction to AUTHORIZED with `authorizationExpiresAt = now + 30 min`.
- Reject → REJECTED + release. Expiry job → EXPIRED + release. **Never auto-approve.**
- **Humans can override ESCALATE only.** BLOCK is final; to allow it, the user confirms a new policy version and the agent resubmits.
- The agent learns outcomes by polling (an outbound agent callback may come later).

### 6.3 PayPal Checkout (separate checkpoint)

- Server creates the order **only from stored, authorized values**: amount, currency, payee = registered merchant, `custom_id` = `invoice_id` = transaction ID, `intent=CAPTURE`, `PayPal-Request-Id` = transaction ID.
- The approval link is shown to the **user in the dashboard**, never returned to the agent.
- On return redirect or `CHECKOUT.ORDER.APPROVED` webhook: **ignore query params as proof**. `GET /v2/checkout/orders/{id}` server-side; require status APPROVED and exact match on amount, currency, payee, `custom_id`; transaction in ORDER_CREATED and authorization unexpired; re-run BLOCK rules; then capture, and verify the capture result (`COMPLETED`, exact amount). `PENDING` capture stays CAPTURING until the webhook.
- An order Leash does not recognise → audit anomaly, no action.

### 6.4 Webhooks

Verified via PayPal's `verify-webhook-signature` API (transmission headers + configured webhook ID; we never fetch `cert_url` ourselves). Dedupe on `paypalEventId`. Handled: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED/DENIED/PENDING/REFUNDED/REVERSED`. Webhooks reconcile; they can **never** move a transaction into AUTHORIZED.

### 6.5 Refunds

User-initiated only (agents cannot refund in v1). Amount ≤ captured − already refunded. Idempotent via `PayPal-Request-Id`. A completed refund writes a REFUND ledger entry, restoring budget.

### 6.6 Policy compilation

User text → compiler model → DSL JSON → Zod validation (unknown rule types rejected) → sanity checks → **deterministic** English rendering (not LLM-written) + list of unmapped clauses that must be acknowledged → user confirms with step-up → ACTIVE (previous → SUPERSEDED). The $500 sandbox ceiling applies regardless of policy.

**Policy DSL v1 (implemented in Phase 4)** — `packages/shared/src/policy/dsl.ts`. A document has `dslVersion: 1`, a single `currency`, an IANA `timezone`, and up to 50 rules. Each rule has a slug `id`, an `action` (`BLOCK` | `ESCALATE`) and one of 10 types: `max_amount_per_transaction`, `max_spend_per_period` (day/week/month), `max_transactions_per_period`, `merchant_allowlist`, `merchant_blocklist`, `category_allowlist`, `category_blocklist`, `new_merchant`, `time_window`, `duplicate_window`. A rule *matches* when its condition is met; any matched BLOCK → BLOCK, else any matched ESCALATE → ESCALATE, else ALLOW. (The Phase 1 sketch's `approval_above` is `max_amount_per_transaction` with `ESCALATE`; `currency_allowlist` became the single policy `currency`.)

**Built-in rules** (always BLOCK, not removable by any policy): no active policy; sandbox ceiling (50,000 minor units); purchase currency ≠ policy currency; task not active; currency ≠ task currency; merchant not in the task; merchant archived; amount > remaining task budget.

**Periods** are calendar periods in the policy time zone: day from 00:00, week Monday 00:00 → Monday 00:00, month from the 1st. Computed with the runtime's tz database (DST-aware). A purchase counts toward the period in which it was reserved.

**Separation (enforced by lint):** `modules/authorization/policyEngine.ts` is a pure function — no I/O, no clock, no LLM. `modules/budget/ledger.ts` gathers spend facts and calls it. Neither may import `llm/`, `modules/evaluation/` or the Anthropic SDK. The compiler lives in `llm/` behind the `PolicyCompiler` interface in `modules/policies/compiler.ts`.

**Reservations:** `reserveForPurchase()` runs in one DB transaction holding `pg_advisory_xact_lock(<budget namespace>, hashtext(userId))`: idempotency check → load ACTIVE policy (re-validated) → task and merchant (scoped to the user and agent) → spend snapshot from the ledger → engine → create Transaction (BLOCKED, or EVALUATING with funds held) + POLICY Evaluation + RESERVE ledger entry + audit event. `releaseReservation()` takes the same lock and is idempotent. Confirming or pausing a policy also takes the lock, so no evaluation straddles a policy switch.

**Compiler (LLM) pipeline:** `POST /policies/compile` → Anthropic Messages API with the model from `LLM_MODEL_POLICY_COMPILER`, a versioned system prompt (`policy-compiler/v1`), the user's text in delimited tags, the user's non-archived merchants, and a JSON-schema structured output; no tools. `stop_reason` is checked (refusal/truncation → error), the text is parsed and validated against the output schema, then strictly against the DSL schema plus merchant ownership. Only then is a **DRAFT** stored (with model, prompt version, unmapped clauses and assumptions). Any failure creates nothing and is audited.

**Review & confirmation:** the dashboard shows the deterministic rendering, unmapped clauses (must be acknowledged), compiler assumptions, a dry-run simulator against real spend, and the exact JSON (editable while DRAFT; edits are validated identically and flagged). Confirmation requires the password and the `rulesHash` that was on screen; the previous ACTIVE version becomes SUPERSEDED. "Pause all spending" deactivates the policy (password required); restoring means copying a version into a new draft and confirming it.

### 6.7 Future: PayPal Vault (autonomous payments)

Later phase. The user explicitly vaults a PayPal payment method with a clear consent screen (revocable at any time, scoped to Leash, with its own optional lower ceiling). For ALLOW decisions the server then creates and captures the order using the vaulted payment token without a buyer redirect. Every Leash check (policy, reservations, AI signals, Leash human approval for ESCALATE, server-side verification) stays identical; only the PayPal buyer-approval checkpoint is replaced by the standing vault consent. Implemented as a second `PaymentProvider`.

---

## 7. Security threats and mitigations

| Threat | Mitigation |
|---|---|
| Prompt injection hijacks the **agent** | Leash judges the *purchase*, not the agent's reasoning: deterministic policy + user-authored task intent + injection scanning. A hijacked agent can only *ask*. |
| Prompt injection against **Leash's own LLM calls** | LLM output can only tighten; untrusted text delimited in the user turn; schema-constrained + Zod-validated; no tools; any failure → ESCALATE. A fully-fooled classifier saying "clean" changes nothing — policy and intent still apply. |
| Injection detection treated as a guarantee | It is explicitly an **additional layer**. `sourceContext` is untrusted and may be incomplete or omitted. Primary controls (policy, budgets, merchant registry, task binding) do not depend on it. |
| LLM approves a payment | No payment tools; pure-code combiner; ESLint-enforced import boundary between `authorization/` and `evaluation/`/`llm/`. |
| Agent fabricates the "original instruction" | Tasks are created only via user sessions; agent keys can only reference them. |
| Payee spoofing / look-alike merchants | Payee resolved from registry by ID; order payee re-verified before capture; NFKC normalization; UI shows the PayPal account. |
| Amount/payee tampering between decision and payment | Order built from stored authorized values; server-side GET + exact compare before capture. |
| PayPal buyer approval treated as Leash approval | Two separate checkpoints (§0); capture requires Leash AUTHORIZED **and** a matching order (I3). |
| Forged return URL | Query params ignored; proof comes from a server-side GET. |
| Webhook spoofing / replay | PayPal signature verification, event-ID uniqueness, transmission-time window, webhooks can't authorize. |
| Concurrent requests exceed limits (double-spend, TOCTOU) | Per-user advisory lock, reservations written in the same transaction as the policy check, CAS transitions, idempotency keys, `PayPal-Request-Id`. Covered by concurrency integration tests against real Postgres. |
| Audit chain forks under concurrent writes | Global advisory lock around read-last-hash + insert; ordered `seq`; chain verification endpoint; concurrency tests. |
| Purchase splitting | Per-period amount and count limits, task budget, `duplicate_window`. |
| Compiler mis-translates a rule | Deterministic rendering, sanity bounds, unmapped-clause list, simulator, step-up confirm, global ceiling. |
| Policy tampering | Immutable versions (DB trigger), audited confirmation, `policyVersionId` on every transaction. |
| Approval CSRF / clickjacking / stale approval | SameSite=strict httpOnly cookies, CSRF tokens, `frame-ancestors 'none'`, step-up, `snapshotHash`. |
| CSRF on any dashboard mutation | Three layers (Phase 3): `Origin`/`Sec-Fetch-Site` check; JSON-only bodies (HTML forms can't send them without a CORS preflight, which is never approved); `X-CSRF-Token` = HMAC-SHA256 keyed by the session token, verified in constant time. Login/registration are covered by the first two. |
| Social engineering via agent text / approval fatigue | Untrusted framing, highlighted injection hits, specific reason codes, expiry instead of backlog. |
| XSS via agent content | React escaping, no `dangerouslySetInnerHTML`, strict CSP, plain-text rendering. |
| IDOR / cross-tenant access | Every query scoped by `userId`; keys bound to one agent and user; tests for cross-user access. |
| Agent key theft | Hashed, shown once, revocable, expirable, rate-limited. |
| Leaking thresholds to the agent | Coarse reason codes only. |
| Payment credentials leak | PayPal secrets only in server env, read only by `payments/paypal/client.ts`; never logged (pino redaction), never returned by any API, never sent to the LLM. |
| Accidental live payment | Sandbox URL in code, `PAYPAL_ENV` schema literal `sandbox`, startup guard. |
| LLM cost / DoS amplification | Per-agent rate limits, input size caps, deterministic short-circuit, daily LLM budget (→ ESCALATE when exhausted). |
| Audit log tampering | Append-only trigger, hash chain, `/audit-events/verify`. |
| Currency confusion / float errors | Currency allowlist, no implicit conversion, integer minor units, strict decimal parsing. |

---

## 8. Implementation roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **2. Foundations** | Monorepo, TS, ESLint/Prettier, Vitest; docker-compose Postgres; full Prisma schema + initial migration; Zod env + sandbox guard; Express skeleton (logging, errors, health); Vite/React/Tailwind shell; `packages/shared` | Apps run; migrations apply; lint + tests pass |
| **3. Identity & setup** | Auth (sessions, CSRF, step-up), agents + keys, merchants, tasks, audit writer with concurrency-safe hash chain; dashboard pages | Can create agent key, merchant, task; audit chain verifies under concurrent writes |
| **4. Policy & budget** | DSL, pure policy engine, budget ledger with locking; compiler + deterministic renderer + confirm + simulator | Concurrency tests prove parallel requests can't exceed limits; ledger always balances |
| **5. Evaluation** | Injection heuristics + classifier, intent verifier, combiner, `POST /purchase-requests` end-to-end (no payments) | Adversarial corpus: injected requests never ALLOW; LLM failure → ESCALATE; import boundary enforced |
| **6. Human approval** | Approval queue, approve/reject with step-up + snapshot hash, expiry job, agent polling | Races and expiry tested; BLOCK can't be approved |
| **7. PayPal Checkout (sandbox)** | `PaymentProvider` interface, OAuth client, order creation, return/cancel, verify-then-capture | End-to-end sandbox purchase; tampered/mismatched order refused |
| **8. Webhooks & refunds** | Signature verification, dedupe, reconciliation, partial/full refunds, ledger restoration | Replayed/forged webhooks rejected; refund totals reconcile |
| **9. Hardening & demo** | Demo agent (honest + malicious scenarios), rate limits, CSP review, spend dashboard, docs | Scripted demo of ALLOW / ESCALATE / BLOCK including a blocked injection |
| **10. PayPal Vault (optional)** | Consent flow, vaulted payment tokens, second `PaymentProvider` | Autonomous ALLOW capture with explicit, revocable consent; all Leash checks unchanged |
