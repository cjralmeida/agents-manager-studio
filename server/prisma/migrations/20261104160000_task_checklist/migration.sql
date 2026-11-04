-- Checklist progress (CA / DoD) on board tasks: one row per ticked line, with who ticked it and when.
CREATE TABLE "task_checklist_checks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "checked_by" TEXT NOT NULL,
    "checked_by_kind" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checklist_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_checklist_checks_workspace_id_item_id_code_key" ON "task_checklist_checks"("workspace_id", "item_id", "code");

CREATE INDEX "task_checklist_checks_workspace_id_item_id_idx" ON "task_checklist_checks"("workspace_id", "item_id");

ALTER TABLE "task_checklist_checks" ADD CONSTRAINT "task_checklist_checks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
