-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "task_item_id" TEXT,
ADD COLUMN     "task_ref" TEXT,
ADD COLUMN     "task_url" TEXT;

-- CreateTable
CREATE TABLE "task_boards" (
    "workspace_id" UUID NOT NULL,
    "provider" "git_provider" NOT NULL,
    "host" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "owner_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "readme" TEXT,
    "status_map" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_boards_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "studio_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "studio_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "agents_task_item_id_idx" ON "agents"("task_item_id");

-- AddForeignKey
ALTER TABLE "task_boards" ADD CONSTRAINT "task_boards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
