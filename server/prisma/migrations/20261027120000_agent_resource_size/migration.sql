-- Size an agent was moved to after its container ran out of memory (P, M, G, GG); null keeps the size of its role.
ALTER TABLE "agents" ADD COLUMN "resource_size" TEXT;
