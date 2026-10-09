-- CreateEnum
CREATE TYPE "board_provider" AS ENUM ('GITHUB', 'GITLAB', 'STUDIO');

-- Boards may now live only in the Studio: the provider column changes type in place (values are kept).
ALTER TABLE "task_boards" ALTER COLUMN "provider" TYPE "board_provider" USING ("provider"::text::"board_provider");

-- CreateTable
CREATE TABLE "local_tasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "column_id" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "project_id" UUID,
    "assignees" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "local_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "local_tasks_workspace_id_column_id_idx" ON "local_tasks"("workspace_id", "column_id");

-- CreateIndex
CREATE UNIQUE INDEX "local_tasks_workspace_id_number_key" ON "local_tasks"("workspace_id", "number");

-- AddForeignKey
ALTER TABLE "local_tasks" ADD CONSTRAINT "local_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_tasks" ADD CONSTRAINT "local_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
