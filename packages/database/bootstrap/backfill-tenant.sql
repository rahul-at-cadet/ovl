-- Copies a single-tenant deployment's `public` data into a tenant schema.
--
-- Run once per tenant, as a superuser, when moving an existing installation
-- onto schema-per-tenant. It copies rather than moves: `public` is left intact
-- so the change is reversible by flipping the application back, and so a
-- half-finished cutover never destroys the only copy of anything.
--
-- Usage:
--   psql "$SUPERUSER_DATABASE_URL" -v tenant_schema=tenant_acme_marine \
--        -f packages/database/bootstrap/backfill-tenant.sql
--
-- Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running after a
-- partial failure resumes rather than duplicating. Ordered so that a table
-- always lands after whatever it references, since the tenant schema carries
-- the same foreign keys `public` does.
--
-- Tables whose cursor or id is GENERATED ALWAYS AS IDENTITY are copied with
-- OVERRIDING SYSTEM VALUE, so the original numbers survive. That is not
-- cosmetic: vessels hold those cursors — lastChatSeq, lastRemarkSeq — and
-- letting the identity renumber on copy would make a ship either re-receive
-- everything it had already seen or skip past messages it had not.

\set ON_ERROR_STOP on

\if :{?tenant_schema}
\else
\echo 'ERROR: tenant_schema is required, e.g. -v tenant_schema=tenant_acme_marine'
\quit
\endif

BEGIN;

SET LOCAL search_path TO :tenant_schema;

-- Parents first: everything below references vessels.
INSERT INTO vessels SELECT * FROM public.vessels ON CONFLICT DO NOTHING;

-- Independent of vessels, but needed by config_bundles' composition.
INSERT INTO schema_versions OVERRIDING SYSTEM VALUE SELECT * FROM public.schema_versions ON CONFLICT DO NOTHING;
INSERT INTO config_bundles OVERRIDING SYSTEM VALUE SELECT * FROM public.config_bundles ON CONFLICT DO NOTHING;

-- Vessel-scoped configuration.
INSERT INTO bundle_assignments SELECT * FROM public.bundle_assignments ON CONFLICT DO NOTHING;
INSERT INTO field_policy_assignments SELECT * FROM public.field_policy_assignments ON CONFLICT DO NOTHING;
INSERT INTO cadence_rules SELECT * FROM public.cadence_rules ON CONFLICT DO NOTHING;
INSERT INTO regulatory_profile_assignments SELECT * FROM public.regulatory_profile_assignments ON CONFLICT DO NOTHING;
INSERT INTO rule_severity_assignments SELECT * FROM public.rule_severity_assignments ON CONFLICT DO NOTHING;

-- Vessel state and credentials.
INSERT INTO vessel_sync_status SELECT * FROM public.vessel_sync_status ON CONFLICT DO NOTHING;
INSERT INTO vessel_users SELECT * FROM public.vessel_users ON CONFLICT DO NOTHING;
INSERT INTO user_commands SELECT * FROM public.user_commands ON CONFLICT DO NOTHING;
INSERT INTO enrollments SELECT * FROM public.enrollments ON CONFLICT DO NOTHING;

-- api_keys is deliberately NOT copied.
--
-- Keys minted since the cutover already live in the tenant schema, and every
-- key is also recorded in platform.edge_credentials pointing at one tenant.
-- Copying `public` keys in would create rows the platform index does not know
-- about, so a vessel presenting one would resolve to no tenant and fail in a
-- way that looks like corruption. Re-issue instead; it is one action per
-- vessel and it leaves the index and the schema agreeing.

-- Reports and their history.
INSERT INTO report_versions SELECT * FROM public.report_versions ON CONFLICT DO NOTHING;
INSERT INTO report_audit_events OVERRIDING SYSTEM VALUE SELECT * FROM public.report_audit_events ON CONFLICT DO NOTHING;
INSERT INTO report_reviews SELECT * FROM public.report_reviews ON CONFLICT DO NOTHING;
INSERT INTO report_attachments SELECT * FROM public.report_attachments ON CONFLICT DO NOTHING;

-- Message streams.
INSERT INTO chat_messages SELECT * FROM public.chat_messages ON CONFLICT DO NOTHING;
INSERT INTO remarks SELECT * FROM public.remarks ON CONFLICT DO NOTHING;
INSERT INTO invalidation_notices SELECT * FROM public.invalidation_notices ON CONFLICT DO NOTHING;

COMMIT;

-- Verify, per table:
--   SELECT 'vessels', count(*) FROM :tenant_schema.vessels
--   UNION ALL SELECT 'report_versions', count(*) FROM :tenant_schema.report_versions;
