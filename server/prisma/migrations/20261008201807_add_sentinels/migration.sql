-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "sentinel_id" UUID;

-- AlterTable
ALTER TABLE "task_boards" ADD COLUMN     "last_sync_error" TEXT,
ADD COLUMN     "last_synced_at" TIMESTAMPTZ(3),
ADD COLUMN     "refresh_interval_sec" INTEGER NOT NULL DEFAULT 120;

-- CreateTable
CREATE TABLE "sentinels" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "field_filters" JSONB NOT NULL DEFAULT '{}',
    "repositories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "column_id" TEXT,
    "only_unassigned" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'sonnet',
    "max_concurrent" INTEGER NOT NULL DEFAULT 1,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_launch_at" TIMESTAMPTZ(3),
    "status_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sentinels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sentinels_workspace_id_idx" ON "sentinels"("workspace_id");

-- CreateIndex
CREATE INDEX "agents_sentinel_id_idx" ON "agents"("sentinel_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_sentinel_id_fkey" FOREIGN KEY ("sentinel_id") REFERENCES "sentinels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentinels" ADD CONSTRAINT "sentinels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
