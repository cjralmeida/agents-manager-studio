-- AlterTable
ALTER TABLE "preview_builds" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'static',
ADD COLUMN     "target" TEXT;

