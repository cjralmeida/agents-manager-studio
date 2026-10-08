-- CreateEnum
CREATE TYPE "agent_output" AS ENUM ('PULL_REQUEST', 'RESULT');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "auto_conclude" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "instructions" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "output" "agent_output" NOT NULL DEFAULT 'PULL_REQUEST',
ADD COLUMN     "profile_id" UUID,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "project_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'sonnet',
    "project_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "output" "agent_output" NOT NULL DEFAULT 'PULL_REQUEST',
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_conclude" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_workspace_id_name_key" ON "agent_profiles"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "agents_profile_id_idx" ON "agents"("profile_id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "agent_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
