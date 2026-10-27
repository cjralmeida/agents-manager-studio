-- Size chosen for a profile in Configurações → Recursos (P, M, G, GG); null: by the role it names.
ALTER TABLE "agent_profiles" ADD COLUMN "resource_size" TEXT;
-- Size the agent's container was started with, and what it used (peaks and the CPU average), for the Gestor de Capacidade.
ALTER TABLE "agents" ADD COLUMN "size_name" TEXT;
ALTER TABLE "agents" ADD COLUMN "peak_memory_mb" INTEGER;
ALTER TABLE "agents" ADD COLUMN "peak_cpu_percent" DOUBLE PRECISION;
ALTER TABLE "agents" ADD COLUMN "cpu_percent_sum" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "agents" ADD COLUMN "usage_samples" INTEGER NOT NULL DEFAULT 0;
