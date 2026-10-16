-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "log" TEXT;

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN "aws_account_id" UUID;

-- CreateTable
CREATE TABLE "aws_accounts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "access_key_id" TEXT NOT NULL,
    "secret_access_key_enc" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "aws_account_number" TEXT NOT NULL,
    "identity_arn" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "aws_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aws_services" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" "deploy_environment" NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "branch" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "aws_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_settings_aws_account_id_idx" ON "workspace_settings"("aws_account_id");
CREATE INDEX "aws_accounts_owner_id_idx" ON "aws_accounts"("owner_id");
CREATE UNIQUE INDEX "aws_services_project_id_environment_key" ON "aws_services"("project_id", "environment");
CREATE INDEX "aws_services_workspace_id_idx" ON "aws_services"("workspace_id");

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_aws_account_id_fkey" FOREIGN KEY ("aws_account_id") REFERENCES "aws_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
