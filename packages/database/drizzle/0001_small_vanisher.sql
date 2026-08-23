ALTER TABLE "vessels" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "schema_versions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "schema_versions" ALTER COLUMN "cursor" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "config_bundles" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "config_bundles" ALTER COLUMN "cursor" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "report_audit_events" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "api_key_events" ALTER COLUMN "id" SET MAXVALUE 9223372036854775807;