-- CreateTable
CREATE TABLE "test_user_leases" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "prefix" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "acquired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_user_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "test_user_leases_workspace_id_prefix_key" ON "test_user_leases"("workspace_id", "prefix");

-- CreateIndex
CREATE INDEX "test_user_leases_agent_id_idx" ON "test_user_leases"("agent_id");
