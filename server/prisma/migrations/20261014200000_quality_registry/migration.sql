CREATE TABLE "quality_categories" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'aberta',
    "transversal_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "quality_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quality_categories_workspace_id_name_key" ON "quality_categories"("workspace_id", "name");
ALTER TABLE "quality_categories" ADD CONSTRAINT "quality_categories_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "quality_occurrences" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "task_ref" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "obtained" TEXT NOT NULL,
    "reviewer" TEXT,
    "agent_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_occurrences_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "quality_occurrences_category_id_idx" ON "quality_occurrences"("category_id");
ALTER TABLE "quality_occurrences" ADD CONSTRAINT "quality_occurrences_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "quality_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
