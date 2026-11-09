-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('ALLOW', 'ESCALATE', 'BLOCK');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('EVALUATING', 'BLOCKED', 'PENDING_APPROVAL', 'REJECTED', 'EXPIRED', 'AUTHORIZED', 'ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'CAPTURED', 'PAYMENT_FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvaluationLayer" AS ENUM ('POLICY', 'INJECTION', 'INTENT');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('PASS', 'ESCALATE', 'BLOCK', 'ERROR');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PolicyVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('RESERVE', 'RELEASE', 'REFUND');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'AGENT', 'SYSTEM', 'PAYPAL', 'LLM');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "stepUpAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApiKey" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AgentApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "paypalEmail" TEXT NOT NULL,
    "paypalMerchantId" TEXT,
    "domain" TEXT,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceText" TEXT NOT NULL,
    "compiledRules" JSONB NOT NULL,
    "rulesHash" TEXT NOT NULL,
    "status" "PolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "compilerModel" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "unmappedClauses" JSONB NOT NULL DEFAULT '[]',
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "instruction" TEXT NOT NULL,
    "budgetMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "allowedMerchantIds" UUID[],
    "status" "TaskStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "merchantId" UUID,
    "policyVersionId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "itemDescription" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "category" TEXT,
    "agentJustification" TEXT,
    "untrustedContext" JSONB,
    "status" "TransactionStatus" NOT NULL DEFAULT 'EVALUATING',
    "decision" "Decision",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "snapshotHash" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "authorizationExpiresAt" TIMESTAMP(3),
    "paypalOrderId" TEXT,
    "paypalCaptureId" TEXT,
    "capturedMinor" INTEGER,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "layer" "EvaluationLayer" NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "details" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT,
    "promptVersion" TEXT,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "snapshotHash" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" UUID,
    "note" TEXT,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "paypalRefundId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requestedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "paypalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "payload" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "transactionId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL,
    "userId" UUID,
    "transactionId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentApiKey_keyHash_key" ON "AgentApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "AgentApiKey_agentId_idx" ON "AgentApiKey"("agentId");

-- CreateIndex
CREATE INDEX "Merchant_userId_idx" ON "Merchant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_userId_paypalEmail_key" ON "Merchant"("userId", "paypalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_userId_version_key" ON "PolicyVersion"("userId", "version");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");

-- CreateIndex
CREATE INDEX "Task_agentId_status_idx" ON "Task"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_paypalOrderId_key" ON "Transaction"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_paypalCaptureId_key" ON "Transaction"("paypalCaptureId");

-- CreateIndex
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_userId_status_idx" ON "Transaction"("userId", "status");

-- CreateIndex
CREATE INDEX "Transaction_status_authorizationExpiresAt_idx" ON "Transaction"("status", "authorizationExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_agentId_idempotencyKey_key" ON "Transaction"("agentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Evaluation_transactionId_idx" ON "Evaluation"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_transactionId_key" ON "Approval"("transactionId");

-- CreateIndex
CREATE INDEX "Approval_status_expiresAt_idx" ON "Approval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_currency_createdAt_idx" ON "LedgerEntry"("userId", "currency", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paypalRefundId_key" ON "Refund"("paypalRefundId");

-- CreateIndex
CREATE INDEX "Refund_transactionId_idx" ON "Refund"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_paypalEventId_key" ON "WebhookEvent"("paypalEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_transactionId_idx" ON "WebhookEvent"("transactionId");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_receivedAt_idx" ON "WebhookEvent"("eventType", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_id_key" ON "AuditEvent"("id");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_seq_idx" ON "AuditEvent"("userId", "seq");

-- CreateIndex
CREATE INDEX "AuditEvent_transactionId_seq_idx" ON "AuditEvent"("transactionId", "seq");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentApiKey" ADD CONSTRAINT "AgentApiKey_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Leash guarantees that Prisma's schema language cannot express.
-- See docs/ARCHITECTURE.md §4. These are defence in depth: application code
-- enforces the same rules, but the database refuses to violate them even if
-- a bug slips through.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Money and quantity sanity (integer minor units, never negative) ──────────
ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_amountMinor_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "Transaction_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "Transaction_capturedMinor_nonnegative" CHECK ("capturedMinor" IS NULL OR "capturedMinor" >= 0),
  ADD CONSTRAINT "Transaction_refundedMinor_bounds" CHECK ("refundedMinor" >= 0 AND "refundedMinor" <= COALESCE("capturedMinor", 0)),
  ADD CONSTRAINT "Transaction_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amountMinor_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "LedgerEntry_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_amountMinor_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "Refund_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_budgetMinor_positive" CHECK ("budgetMinor" > 0),
  ADD CONSTRAINT "Task_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "PolicyVersion"
  ADD CONSTRAINT "PolicyVersion_version_positive" CHECK ("version" > 0);

-- ── At most one ACTIVE policy version per user ───────────────────────────────
CREATE UNIQUE INDEX "PolicyVersion_one_active_per_user"
  ON "PolicyVersion" ("userId")
  WHERE "status" = 'ACTIVE';

-- ── Append-only tables: AuditEvent and LedgerEntry ───────────────────────────
CREATE OR REPLACE FUNCTION leash_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'leash: % on "%" is not permitted (append-only table)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION leash_reject_mutation();
CREATE TRIGGER "AuditEvent_no_truncate"
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION leash_reject_mutation();

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION leash_reject_mutation();
CREATE TRIGGER "LedgerEntry_no_truncate"
  BEFORE TRUNCATE ON "LedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION leash_reject_mutation();

-- ── Policy versions are immutable once confirmed ─────────────────────────────
-- DRAFT rows may be edited or deleted. The only change allowed after that is
-- ACTIVE → SUPERSEDED with every content column unchanged.
CREATE OR REPLACE FUNCTION leash_policy_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'DRAFT' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'leash: PolicyVersion % is % and cannot be deleted', OLD."id", OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED'
     AND NEW."userId" = OLD."userId"
     AND NEW."version" = OLD."version"
     AND NEW."sourceText" = OLD."sourceText"
     AND NEW."compiledRules" = OLD."compiledRules"
     AND NEW."rulesHash" = OLD."rulesHash"
     AND NEW."compilerModel" = OLD."compilerModel"
     AND NEW."promptVersion" = OLD."promptVersion"
     AND NEW."unmappedClauses" = OLD."unmappedClauses"
     AND NEW."confirmedAt" IS NOT DISTINCT FROM OLD."confirmedAt"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'leash: PolicyVersion % is % and immutable', OLD."id", OLD."status"
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "PolicyVersion_immutable"
  BEFORE UPDATE OR DELETE ON "PolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION leash_policy_version_guard();
