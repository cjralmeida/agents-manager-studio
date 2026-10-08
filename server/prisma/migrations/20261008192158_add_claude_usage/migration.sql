-- AlterTable
ALTER TABLE "agent_accounts" ADD COLUMN     "plan_usage" JSONB,
ADD COLUMN     "plan_usage_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "usage_totals" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "agent_usage" (
    "id" SERIAL NOT NULL,
    "agent_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL,
    "cache_creation_tokens" INTEGER NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_usage_created_at_idx" ON "agent_usage"("created_at");

-- CreateIndex
CREATE INDEX "agent_usage_agent_id_idx" ON "agent_usage"("agent_id");

-- AddForeignKey
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
