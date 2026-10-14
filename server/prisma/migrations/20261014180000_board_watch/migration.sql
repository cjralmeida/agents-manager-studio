ALTER TABLE "task_boards" ADD COLUMN "watch_interval_min" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "task_boards" ADD COLUMN "last_watched_at" TIMESTAMPTZ(3);
