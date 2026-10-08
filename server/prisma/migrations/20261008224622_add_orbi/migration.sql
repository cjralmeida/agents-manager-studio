-- CreateEnum
CREATE TYPE "agent_kind" AS ENUM ('TASK', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "proposal_status" AS ENUM ('PENDING', 'APPLIED', 'DISCARDED', 'FAILED');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "kind" "agent_kind" NOT NULL DEFAULT 'TASK';

-- CreateTable
CREATE TABLE "assistant_proposals" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "proposal_status" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "assistant_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_proposals_agent_id_idx" ON "assistant_proposals"("agent_id");

-- CreateIndex
CREATE INDEX "agents_workspace_id_kind_idx" ON "agents"("workspace_id", "kind");

-- AddForeignKey
ALTER TABLE "assistant_proposals" ADD CONSTRAINT "assistant_proposals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
