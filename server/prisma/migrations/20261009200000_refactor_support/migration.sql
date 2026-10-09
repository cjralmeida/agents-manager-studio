-- AlterTable
ALTER TABLE "agent_profiles" ADD COLUMN     "context_project_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "context_project_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "base_branch" TEXT;

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "clickup_account_id" UUID;

-- CreateTable
CREATE TABLE "clickup_accounts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clickup_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clickup_accounts_owner_id_idx" ON "clickup_accounts"("owner_id");

-- CreateIndex
CREATE INDEX "workspace_settings_clickup_account_id_idx" ON "workspace_settings"("clickup_account_id");

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_clickup_account_id_fkey" FOREIGN KEY ("clickup_account_id") REFERENCES "clickup_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clickup_accounts" ADD CONSTRAINT "clickup_accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

