-- CreateEnum
CREATE TYPE "agent_provider" AS ENUM ('CLAUDE');

-- CreateTable
CREATE TABLE "git_accounts" (
    "id" UUID NOT NULL,
    "provider" "git_provider" NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "git_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_accounts" (
    "id" UUID NOT NULL,
    "provider" "agent_provider" NOT NULL DEFAULT 'CLAUDE',
    "label" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_settings" (
    "workspace_id" UUID NOT NULL,
    "agent_account_id" UUID,
    "enabled_skill_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "workspace_git_accounts" (
    "workspace_id" UUID NOT NULL,
    "git_account_id" UUID NOT NULL,

    CONSTRAINT "workspace_git_accounts_pkey" PRIMARY KEY ("workspace_id","git_account_id")
);

-- CreateIndex
CREATE INDEX "workspace_settings_agent_account_id_idx" ON "workspace_settings"("agent_account_id");

-- CreateIndex
CREATE INDEX "workspace_git_accounts_git_account_id_idx" ON "workspace_git_accounts"("git_account_id");

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_agent_account_id_fkey" FOREIGN KEY ("agent_account_id") REFERENCES "agent_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_git_accounts" ADD CONSTRAINT "workspace_git_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_git_accounts" ADD CONSTRAINT "workspace_git_accounts_git_account_id_fkey" FOREIGN KEY ("git_account_id") REFERENCES "git_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
