-- A workspace board can join several sources (GitHub Project, GitLab group board, Studio tasks).
-- Existing rows get an id before it becomes the primary key.
ALTER TABLE "task_boards" ADD COLUMN "id" UUID;
UPDATE "task_boards" SET "id" = gen_random_uuid();
ALTER TABLE "task_boards" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "task_boards" DROP CONSTRAINT "task_boards_pkey";
ALTER TABLE "task_boards" ADD CONSTRAINT "task_boards_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "task_boards_workspace_id_idx" ON "task_boards"("workspace_id");
