-- Aprendizado: each category of the quality registry gets the stage whose agents learn from it and the lesson they follow.
ALTER TABLE "quality_categories" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'codificacao';
ALTER TABLE "quality_categories" ADD COLUMN "lesson" TEXT;
