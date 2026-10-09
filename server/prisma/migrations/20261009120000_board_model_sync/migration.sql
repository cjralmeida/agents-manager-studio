-- AlterTable
ALTER TABLE "task_boards" ADD COLUMN     "model_map" JSONB,
ADD COLUMN     "model_status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "model_sync_error" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "task_boards_provider_host_external_id_key" ON "task_boards"("provider", "host", "external_id");
