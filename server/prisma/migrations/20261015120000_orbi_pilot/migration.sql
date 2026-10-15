CREATE TABLE "orbi_activities" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "workspace_id" UUID,
    "conversation_id" UUID,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "link" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orbi_activities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "orbi_activities_owner_id_created_at_idx" ON "orbi_activities"("owner_id", "created_at");
ALTER TABLE "orbi_activities" ADD CONSTRAINT "orbi_activities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "orbi_pilot_events" (
    "owner_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orbi_pilot_events_pkey" PRIMARY KEY ("owner_id", "key")
);
ALTER TABLE "orbi_pilot_events" ADD CONSTRAINT "orbi_pilot_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
