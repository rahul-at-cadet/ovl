-- What a vessel calls itself, and the log of its check-ins.
--
-- Both arrived with the vessel sync-diagnostics work, which was written
-- against the single shared `public` schema and so only reached
-- `drizzle/`. That path no longer provisions anything: a tenant schema is
-- built from bootstrap/fresh-database.sql plus this directory. Without this
-- file every tenant kept a vessel_sync_status with no reported_* columns,
-- and pullConfig failed on its very first insert with `column
-- "reported_name" ... does not exist`.
--
-- Unqualified and additive, per this directory's rules.

ALTER TABLE vessel_sync_status ADD COLUMN IF NOT EXISTS reported_name text;
ALTER TABLE vessel_sync_status ADD COLUMN IF NOT EXISTS reported_imo text;

-- Shore's half of each sync cycle, append-only.
--
-- Deliberately NOT foreign-keyed to `vessels`: the most diagnostic row in
-- this table is a check-in from a vessel this office cannot identify, and an
-- FK would reject exactly that insert. `tenant_id` is vestigial under
-- schema-per-tenant — every row here already belongs to the schema it sits
-- in — and is kept only so the column matches schema.ts.
CREATE TABLE IF NOT EXISTS sync_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               text NOT NULL DEFAULT 'default',
    run_id                  text,
    vessel_id               uuid NOT NULL,
    received_at             timestamp with time zone NOT NULL,
    outcome                 text NOT NULL,
    resolved_bundle_id      text,
    resolved_bundle_version bigint,
    reported_name           text,
    reported_imo            text,
    note                    text
);
CREATE INDEX IF NOT EXISTS ix_sync_runs_vessel_received
    ON sync_runs USING btree (vessel_id, received_at DESC NULLS FIRST);
CREATE INDEX IF NOT EXISTS ix_sync_runs_tenant_received
    ON sync_runs USING btree (tenant_id, received_at DESC NULLS FIRST);
