ALTER TABLE "vessel_sync_status" ADD COLUMN IF NOT EXISTS "applied_schemas" jsonb DEFAULT '[]'::jsonb NOT NULL;
