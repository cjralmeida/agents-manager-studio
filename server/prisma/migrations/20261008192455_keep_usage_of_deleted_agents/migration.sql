-- DropForeignKey
ALTER TABLE "agent_usage" DROP CONSTRAINT "agent_usage_agent_id_fkey";

-- AlterTable
ALTER TABLE "agent_usage" ALTER COLUMN "agent_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
