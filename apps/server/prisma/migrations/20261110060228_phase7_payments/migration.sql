-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "capturedAt" TIMESTAMP(3),
ADD COLUMN     "orderCreatedAt" TIMESTAMP(3),
ADD COLUMN     "payeeEmail" TEXT,
ADD COLUMN     "paymentFailureReason" TEXT;

-- Purchases decided before this migration that can still be paid: fix the payee
-- to the merchant's PayPal account as it is now (pending approvals re-verify it
-- against their snapshot hash when approved).
UPDATE "Transaction" t
SET "payeeEmail" = m."paypalEmail"
FROM "Merchant" m
WHERE t."merchantId" = m."id"
  AND t."payeeEmail" IS NULL
  AND t."status" IN ('PENDING_APPROVAL', 'AUTHORIZED');
