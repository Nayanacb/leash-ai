-- AlterTable
ALTER TABLE "AgentApiKey" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "archivedAt" TIMESTAMP(3);
