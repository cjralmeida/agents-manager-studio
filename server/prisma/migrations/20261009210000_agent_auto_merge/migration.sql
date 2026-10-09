-- AlterTable
ALTER TABLE "agent_profiles" ADD COLUMN     "auto_merge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "auto_merge" BOOLEAN NOT NULL DEFAULT false;

