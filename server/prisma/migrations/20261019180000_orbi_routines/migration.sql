-- Órbi routines: scheduled or event-driven work in the user's one Órbi conversation (replace the two pilots).
CREATE TABLE "orbi_routines" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "workspace_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "every_minutes" INTEGER,
    "daily_at" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mode" TEXT NOT NULL DEFAULT 'assistant',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orbi_routines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "orbi_routines_owner_id_idx" ON "orbi_routines"("owner_id");

ALTER TABLE "orbi_routines" ADD CONSTRAINT "orbi_routines_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
