-- AlterTable
ALTER TABLE "agent_accounts" ALTER COLUMN "owner_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "git_accounts" ALTER COLUMN "owner_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "render_accounts" ALTER COLUMN "owner_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "owner_id" SET NOT NULL;

