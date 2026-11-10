-- CreateEnum
CREATE TYPE "RefundSource" AS ENUM ('LEASH', 'PAYPAL');

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "refundId" UUID;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "source" "RefundSource" NOT NULL DEFAULT 'LEASH',
ALTER COLUMN "requestedByUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transmissionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_refundId_key" ON "LedgerEntry"("refundId");

-- CreateIndex
CREATE INDEX "Refund_status_updatedAt_idx" ON "Refund"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_receivedAt_idx" ON "WebhookEvent"("processedAt", "receivedAt");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

