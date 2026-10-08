/*
  Warnings:

  - You are about to drop the column `sentinel_id` on the `agents` table. All the data in the column will be lost.
  - You are about to drop the `sentinels` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "workflow_run_status" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "workflow_step_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'RETRIED', 'CANCELLED');

-- DropForeignKey
ALTER TABLE "agents" DROP CONSTRAINT "agents_sentinel_id_fkey";

-- DropForeignKey
ALTER TABLE "sentinels" DROP CONSTRAINT "sentinels_workspace_id_fkey";

-- DropIndex
DROP INDEX "agents_sentinel_id_idx";

-- AlterTable
ALTER TABLE "agents" DROP COLUMN "sentinel_id",
ADD COLUMN     "workflow_run_id" UUID;

-- DropTable
DROP TABLE "sentinels";

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "max_concurrent_runs" INTEGER NOT NULL DEFAULT 1,
    "last_checked_at" TIMESTAMPTZ(3),
    "status_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "workflow_run_status" NOT NULL DEFAULT 'RUNNING',
    "trigger" JSONB NOT NULL,
    "task_item_id" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step_runs" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "lane" TEXT NOT NULL DEFAULT 'main',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "workflow_step_status" NOT NULL DEFAULT 'RUNNING',
    "agent_id" UUID,
    "deployment_id" UUID,
    "output" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflows_workspace_id_name_key" ON "workflows"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_id_status_idx" ON "workflow_runs"("workflow_id", "status");

-- CreateIndex
CREATE INDEX "workflow_runs_workspace_id_started_at_idx" ON "workflow_runs"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "workflow_runs_task_item_id_idx" ON "workflow_runs"("task_item_id");

-- CreateIndex
CREATE INDEX "workflow_step_runs_run_id_idx" ON "workflow_step_runs"("run_id");

-- CreateIndex
CREATE INDEX "workflow_step_runs_agent_id_idx" ON "workflow_step_runs"("agent_id");

-- CreateIndex
CREATE INDEX "agents_workflow_run_id_idx" ON "agents"("workflow_run_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
