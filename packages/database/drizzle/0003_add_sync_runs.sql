CREATE TABLE IF NOT EXISTS "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"run_id" text,
	"vessel_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"resolved_bundle_id" text,
	"resolved_bundle_version" bigint,
	"reported_name" text,
	"reported_imo" text,
	"note" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_sync_runs_vessel_received" ON "sync_runs" USING btree ("vessel_id","received_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_sync_runs_tenant_received" ON "sync_runs" USING btree ("tenant_id","received_at" DESC NULLS FIRST);