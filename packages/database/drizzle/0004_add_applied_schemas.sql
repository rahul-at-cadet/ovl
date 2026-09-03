ALTER TABLE "vessel_sync_status" ADD COLUMN IF NOT EXISTS "applied_schemas" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- applied_bundle_id changes meaning here. Office used to write its own
-- resolution into it and then compare that against the same resolution,
-- so the Fleet Configuration status could only ever agree with itself; it
-- now holds what the *vessel* reports actually holding.
--
-- Every existing value was written under the old meaning, and for a
-- vessel that is currently offline it will never be corrected by a
-- check-in — it would keep reading as Synced on evidence office invented.
-- Clearing them states the truth instead: shore does not know what these
-- ships hold until each one says so, which it does on its next check-in.
UPDATE "vessel_sync_status" SET "applied_bundle_id" = '', "applied_bundle_version" = 0;
