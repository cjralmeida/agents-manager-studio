-- The Gestor de Capacidade now hands its signals to Órbi's pilot, or leaves them as a suggestion the user applies.
ALTER TABLE "capacity_reviews" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "capacity_reviews" ADD COLUMN "summary" TEXT;
