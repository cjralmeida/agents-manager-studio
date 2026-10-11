-- CreateEnum
CREATE TYPE "preview_build_status" AS ENUM ('RUNNING', 'PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "preview_builds" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "commit_message" TEXT NOT NULL DEFAULT '',
    "status" "preview_build_status" NOT NULL DEFAULT 'RUNNING',
    "log" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "preview_builds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_previews" (
    "project_id" UUID NOT NULL,
    "wants_up" BOOLEAN NOT NULL DEFAULT false,
    "container_id" TEXT,
    "build_id" UUID,
    "error" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_previews_pkey" PRIMARY KEY ("project_id")
);

-- CreateIndex
CREATE INDEX "preview_builds_project_id_started_at_idx" ON "preview_builds"("project_id", "started_at");

-- AddForeignKey
ALTER TABLE "preview_builds" ADD CONSTRAINT "preview_builds_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_previews" ADD CONSTRAINT "project_previews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

