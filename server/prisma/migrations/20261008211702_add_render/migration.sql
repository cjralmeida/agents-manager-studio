-- CreateEnum
CREATE TYPE "deploy_environment" AS ENUM ('HOMOLOGACAO', 'PRODUCAO');

-- CreateTable
CREATE TABLE "render_connections" (
    "workspace_id" UUID NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "api_key_hint" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "render_connections_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "render_services" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" "deploy_environment" NOT NULL,
    "service_id" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "branch" TEXT,
    "url" TEXT,
    "dashboard_url" TEXT,

    CONSTRAINT "render_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "environment" "deploy_environment" NOT NULL,
    "service_id" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "render_deploy_id" TEXT,
    "status" TEXT NOT NULL,
    "commit_id" TEXT,
    "pr_url" TEXT,
    "agent_id" UUID,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "render_services_project_id_environment_key" ON "render_services"("project_id", "environment");

-- CreateIndex
CREATE INDEX "deployments_workspace_id_started_at_idx" ON "deployments"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "deployments_finished_at_idx" ON "deployments"("finished_at");

-- AddForeignKey
ALTER TABLE "render_connections" ADD CONSTRAINT "render_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_services" ADD CONSTRAINT "render_services_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_services" ADD CONSTRAINT "render_services_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
