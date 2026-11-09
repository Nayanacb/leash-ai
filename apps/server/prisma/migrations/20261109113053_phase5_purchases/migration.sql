-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'CANCELLED';

-- CreateIndex
CREATE INDEX "Transaction_status_createdAt_idx" ON "Transaction"("status", "createdAt");
