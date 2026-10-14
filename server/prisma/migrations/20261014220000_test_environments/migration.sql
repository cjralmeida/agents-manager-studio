CREATE TABLE "test_environments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "agent_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "commit" TEXT,
    "memory_mb" INTEGER NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "urls" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "log" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(3),
    "stopped_at" TIMESTAMPTZ(3),
    CONSTRAINT "test_environments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "test_environments_status_idx" ON "test_environments"("status");
