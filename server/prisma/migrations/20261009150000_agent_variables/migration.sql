-- CreateTable
CREATE TABLE "agent_variables" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "value_hint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_variables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_variables_workspace_id_key_key" ON "agent_variables"("workspace_id", "key");

-- AddForeignKey
ALTER TABLE "agent_variables" ADD CONSTRAINT "agent_variables_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

