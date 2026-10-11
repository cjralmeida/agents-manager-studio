
-- CreateTable
CREATE TABLE "capacity_reviews" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "signature" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "agent_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capacity_reviews_workspace_id_created_at_idx" ON "capacity_reviews"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "capacity_reviews" ADD CONSTRAINT "capacity_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reviews" ADD CONSTRAINT "capacity_reviews_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
