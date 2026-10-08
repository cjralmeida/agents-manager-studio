-- CreateEnum
CREATE TYPE "agent_status" AS ENUM ('PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "agent_inbox_kind" AS ENUM ('MESSAGE', 'ANSWER');

-- AlterTable
ALTER TABLE "git_accounts" ADD COLUMN     "author_email" TEXT,
ADD COLUMN     "author_name" TEXT;

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "agent_status" NOT NULL DEFAULT 'PREPARING',
    "base_branch" TEXT NOT NULL,
    "base_commit" TEXT,
    "branch" TEXT NOT NULL,
    "workdir" TEXT NOT NULL,
    "session_id" TEXT,
    "container_id" TEXT,
    "secret_hash" TEXT,
    "pending_question" JSONB,
    "pr_url" TEXT,
    "error_message" TEXT,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" SERIAL NOT NULL,
    "agent_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_inbox" (
    "id" SERIAL NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" "agent_inbox_kind" NOT NULL,
    "payload" JSONB NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_workspace_id_idx" ON "agents"("workspace_id");

-- CreateIndex
CREATE INDEX "agents_project_id_idx" ON "agents"("project_id");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE INDEX "agent_events_agent_id_id_idx" ON "agent_events"("agent_id", "id");

-- CreateIndex
CREATE INDEX "agent_inbox_agent_id_delivered_at_idx" ON "agent_inbox"("agent_id", "delivered_at");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
