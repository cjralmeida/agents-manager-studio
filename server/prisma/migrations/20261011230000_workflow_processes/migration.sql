-- AlterTable
ALTER TABLE "workflows" ADD COLUMN     "process_id" UUID;

-- CreateTable
CREATE TABLE "workflow_processes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_processes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_processes_workspace_id_name_key" ON "workflow_processes"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "workflows_process_id_idx" ON "workflows"("process_id");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "workflow_processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_processes" ADD CONSTRAINT "workflow_processes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

