-- Control-plane bootstrap for schema-per-tenant multi-tenancy.
--
-- Run ONCE per database, as a superuser (or the database owner), before the
-- office API is started in multi-tenant mode. It is idempotent — re-running it
-- is safe and is the intended way to repair drifted grants.
--
-- Usage (as a superuser — this is the one step that needs one):
--   psql "$SUPERUSER_DATABASE_URL" \
--        -v api_password="$OVL_API_DB_PASSWORD" \
--        -v admin_password="$OVL_ADMIN_DB_PASSWORD" \
--        -f packages/database/bootstrap/platform-bootstrap.sql
--
-- Credentials for local development live in .env.tenancy (gitignored); see
-- .env.tenancy.example for the full list and how to regenerate them.
--
-- What this establishes is the bulkhead the whole design rests on: the role
-- the API pool logs in as (`ovl_api`) is NOINHERIT and owns nothing. It is a
-- *member* of each tenant's role but carries none of their privileges until a
-- transaction explicitly does `SET LOCAL ROLE tenant_<slug>_rw`. So a request
-- that forgets to select a tenant, or names the wrong schema, gets
-- "permission denied for schema" — an error, not another operator's fleet.
--
-- Per-tenant schemas and roles are NOT created here. TenantProvisioningService
-- creates those (see apps/api-office/src/tenancy/tenant-provisioning.service.ts),
-- because onboarding is an application operation, not a one-off DBA task.

\set ON_ERROR_STOP on

\if :{?api_password}
\else
\echo 'ERROR: api_password is required.'
\echo '  psql "$SUPERUSER_DATABASE_URL" -v api_password=... -v admin_password=... -f platform-bootstrap.sql'
\quit
\endif

\if :{?admin_password}
\else
\echo 'ERROR: admin_password is required.'
\echo '  psql "$SUPERUSER_DATABASE_URL" -v api_password=... -v admin_password=... -f platform-bootstrap.sql'
\quit
\endif

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Control-plane schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL,
    name        text NOT NULL,
    schema_name text NOT NULL,
    role_name   text NOT NULL,
    status      text NOT NULL DEFAULT 'provisioning',
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    updated_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT tenants_status_check
        CHECK (status IN ('provisioning', 'active', 'suspended', 'archived')),
    -- Belt and braces on the naming rules the application also enforces
    -- (see tenant-identifiers.ts). A row that cannot pass these can never be
    -- turned into SQL by the provisioning service.
    CONSTRAINT tenants_slug_shape_check
        CHECK (slug ~ '^[a-z][a-z0-9_]{1,40}$'),
    CONSTRAINT tenants_schema_name_shape_check
        CHECK (schema_name ~ '^tenant_[a-z0-9_]{1,48}$'),
    CONSTRAINT tenants_role_name_shape_check
        CHECK (role_name ~ '^tenant_[a-z0-9_]{1,48}_rw$')
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_key ON platform.tenants (slug);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_schema_name_key ON platform.tenants (schema_name);
CREATE INDEX IF NOT EXISTS tenants_status_idx ON platform.tenants (status);

CREATE TABLE IF NOT EXISTS platform.tenant_users (
    supertokens_user_id text PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES platform.tenants (id) ON DELETE CASCADE,
    created_at          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_users_tenant_id_idx ON platform.tenant_users (tenant_id);

-- A tenant's own branding and locale, edited by its administrators.
--
-- Kept beside `name` rather than in the tenant's own schema because they are
-- the same kind of fact — who this customer is — and the office shell reads
-- them on every page load, before any tenant role is assumed. Added as ALTERs
-- so an existing database picks them up on the next idempotent re-run.
--
-- The logo is a data URI rather than a path or a bucket key. It is the one
-- choice here that avoids introducing object storage for a single small image
-- per customer, it is atomic with the rest of the row, and it survives a
-- restore with no second system to keep in step. Size is capped in the
-- application (see TenantSettingsService) rather than by a column type,
-- because the limit is about what is sensible to inline in a page, not about
-- what Postgres can hold.
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS logo_data_url text;
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS default_timezone text NOT NULL DEFAULT 'UTC';

-- Who may publish into the master catalogue.
--
-- Deliberately NOT a value in `users.roles`: that table lives inside a tenant
-- schema and its roles are tenant-scoped by definition, so an 'admin' there is
-- an administrator *of that tenant*. A platform super admin sits above tenants
-- and therefore has to be recorded above them too.
--
-- ovl_api can read this without assuming any role, because the check has to
-- happen *before* deciding whether to assume platform_publisher. It cannot
-- write it — membership is granted out of band via the CLI, so a compromised
-- request path cannot promote anyone, including itself.
CREATE TABLE IF NOT EXISTS platform.super_admins (
    supertokens_user_id text PRIMARY KEY,
    email               text NOT NULL,
    note                text,
    created_at          timestamp with time zone NOT NULL DEFAULT now(),
    created_by          text
);

-- Which tenant a super admin is currently looking at.
--
-- A super admin has no tenant of their own — they sit above every tenant — but
-- they can view any tenant's users, vessels and reports. Which one they are
-- viewing has to live somewhere the server controls: TenantMiddleware resolves
-- the tenant from the authenticated session and from nothing the caller sends,
-- precisely so that nominating a tenant cannot become a way around
-- authentication. A super admin nominating one is legitimate, so the choice is
-- recorded here, server-side, against their identity — and ovl_api may read it
-- but not write it, exactly like super_admins itself.
CREATE TABLE IF NOT EXISTS platform.super_admin_tenant_selection (
    supertokens_user_id text PRIMARY KEY
        REFERENCES platform.super_admins (supertokens_user_id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL REFERENCES platform.tenants (id) ON DELETE CASCADE,
    selected_at         timestamp with time zone NOT NULL DEFAULT now(),

    -- 'read' or 'write'. Read is the default and is the mode an operator
    -- spends almost all of their time in: looking at a customer's data to
    -- answer a question. Write is entered deliberately.
    mode                text NOT NULL DEFAULT 'read'
        CONSTRAINT super_admin_tenant_selection_mode_check CHECK (mode IN ('read', 'write')),

    -- When write mode lapses back to read. Write access that lasts until
    -- someone remembers to turn it off is write access that is always on, and
    -- an operator who has forgotten they are in write mode inside a customer's
    -- tenant is the failure this prevents. NULL whenever mode is 'read'.
    write_expires_at    timestamp with time zone
);
-- Both columns are added separately as well, so a database bootstrapped before
-- they existed picks them up on the next idempotent re-run.
ALTER TABLE platform.super_admin_tenant_selection
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'read';
ALTER TABLE platform.super_admin_tenant_selection
    ADD COLUMN IF NOT EXISTS write_expires_at timestamp with time zone;

-- Which tenant a vessel's API key belongs to.
--
-- Edge (vessel) traffic authenticates with a bearer token, not a session, so
-- there is no tenant to resolve from — and the api_keys table that would answer
-- the question lives *inside* a tenant schema. This index breaks that
-- chicken-and-egg: lookup hash to tenant, readable by ovl_api before any role
-- is assumed.
--
-- It holds no secret. token_lookup_hash is derived from the first 8 characters
-- of the token and is an index, never a credential: authentication still
-- requires the full token hash to match the api_keys row inside that tenant's
-- schema. Someone who read this whole table would learn how many vessels each
-- tenant has and nothing else.
CREATE TABLE IF NOT EXISTS platform.edge_credentials (
    token_lookup_hash text PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES platform.tenants (id) ON DELETE CASCADE,
    label             text,
    created_at        timestamp with time zone NOT NULL DEFAULT now(),
    revoked_at        timestamp with time zone
);

CREATE INDEX IF NOT EXISTS edge_credentials_tenant_id_idx
    ON platform.edge_credentials (tenant_id);

CREATE TABLE IF NOT EXISTS platform.tenant_migrations (
    tenant_id  uuid NOT NULL REFERENCES platform.tenants (id) ON DELETE CASCADE,
    version    text NOT NULL,
    checksum   text,
    applied_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, version)
);

-- ---------------------------------------------------------------------------
-- 2. Lock down the defaults
--
-- Postgres grants CREATE and USAGE on `public` to PUBLIC by default (pre-15),
-- and CONNECT on the database to PUBLIC. Neither is wanted here: a tenant role
-- should be able to reach its own schema and nothing else.
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

-- ---------------------------------------------------------------------------
-- 3. The role the API pool logs in as
--
-- NOINHERIT is load-bearing. With it, membership in tenant roles is dormant:
-- privileges apply only after an explicit SET ROLE, and only for that tenant,
-- and only until the transaction ends. Remove it and layer 04 of the isolation
-- model silently disappears while every test still passes.
-- ---------------------------------------------------------------------------

-- Written with \gexec rather than a DO block on purpose: psql does NOT
-- interpolate :'variables' inside dollar-quoted strings, so `:'api_password'`
-- within a DO $$ ... $$ body reaches the server as literal text and fails to
-- parse. Building the statement in SQL and executing it with \gexec keeps the
-- substitution in a context where psql actually performs it.
SELECT format('CREATE ROLE %I NOLOGIN', 'ovl_api')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ovl_api')
\gexec

-- Applied unconditionally so re-running repairs a drifted role: restores
-- NOINHERIT if someone removed it, and resets the password.
SELECT format('ALTER ROLE %I LOGIN NOINHERIT PASSWORD %L', 'ovl_api', :'api_password')
\gexec

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO ovl_api', current_database());
END
$$;

-- The registry is the only thing ovl_api can touch without assuming a tenant
-- role: enough to answer "which schema does this user belong to?", nothing more.
GRANT USAGE ON SCHEMA platform TO ovl_api;
GRANT SELECT ON platform.tenants, platform.tenant_users, platform.super_admins,
                platform.super_admin_tenant_selection,
                platform.edge_credentials TO ovl_api;

-- Deliberately NOT granted: any privilege on `public`, or on any tenant schema.
-- Those arrive only via GRANT tenant_<slug>_rw TO ovl_api during provisioning.

-- ---------------------------------------------------------------------------
-- 4. The role that provisions tenants
--
-- Separate from ovl_api, and separate from the superuser. Provisioning needs
-- privileges the serving API must never hold — CREATE SCHEMA, CREATE ROLE,
-- GRANT — so it gets its own login role, used only by the CLI and by any
-- dedicated admin deployment.
--
-- NOT a superuser. CREATEROLE plus CREATE on the database is exactly what
-- TenantProvisioningService needs and nothing more: it cannot read tenant data
-- (it is not a member of any tenant role and does not inherit into one by
-- accident), cannot alter ovl_api's NOINHERIT bulkhead, and cannot touch
-- anything outside this database. Running provisioning as `postgres` would
-- work and would also mean every onboarding ran with unlimited rights.
--
-- On PostgreSQL 16+, a CREATEROLE role automatically receives ADMIN OPTION on
-- roles it creates, which is what lets it run `GRANT tenant_x_rw TO ovl_api`
-- and `GRANT tenant_x_rw TO CURRENT_USER` during provisioning.
-- ---------------------------------------------------------------------------

SELECT format('CREATE ROLE %I NOLOGIN', 'ovl_admin')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ovl_admin')
\gexec

SELECT format('ALTER ROLE %I LOGIN CREATEROLE NOSUPERUSER NOCREATEDB PASSWORD %L',
              'ovl_admin', :'admin_password')
\gexec

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO ovl_admin', current_database());
END
$$;

-- Provisioning writes the registry; ovl_api only reads it.
GRANT USAGE ON SCHEMA platform TO ovl_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenants, platform.tenant_users, platform.tenant_migrations,
       platform.super_admins, platform.super_admin_tenant_selection,
       platform.edge_credentials TO ovl_admin;

-- ---------------------------------------------------------------------------
-- 5. Master form-schema catalogue
--
-- Published by a platform super admin, readable by every tenant, writable by
-- none of them. Tenants receive GRANT SELECT and nothing else, so "a tenant can
-- never change a master schema" is enforced by Postgres rather than promised by
-- application code — an UPDATE here comes back `permission denied`.
--
-- A tenant that wants a master schema changed forks it: the document is copied
-- into that tenant's own form_schema_versions and its adoption is repointed at
-- the copy. Nothing in this section is touched.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.form_schemas (
    schema_name text PRIMARY KEY,
    title       text NOT NULL,
    description text,
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    updated_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT form_schemas_status_check CHECK (status IN ('active', 'deprecated'))
);

CREATE TABLE IF NOT EXISTS platform.form_schema_versions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_name      text NOT NULL REFERENCES platform.form_schemas (schema_name) ON DELETE CASCADE,
    version          text NOT NULL,
    ovd_version      text,
    content          jsonb NOT NULL,
    content_checksum text NOT NULL,
    sections         jsonb NOT NULL DEFAULT '[]'::jsonb,
    status           text NOT NULL DEFAULT 'published',
    published_at     timestamp with time zone,
    published_by     text,
    created_at       timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT form_schema_versions_status_check
        CHECK (status IN ('draft', 'published', 'deprecated'))
);

CREATE UNIQUE INDEX IF NOT EXISTS form_schema_versions_name_version_key
    ON platform.form_schema_versions (schema_name, version);
CREATE INDEX IF NOT EXISTS form_schema_versions_checksum_idx
    ON platform.form_schema_versions (content_checksum);
CREATE INDEX IF NOT EXISTS form_schema_versions_status_idx
    ON platform.form_schema_versions (status);

CREATE TABLE IF NOT EXISTS platform.form_schema_fields (
    schema_version_id uuid NOT NULL REFERENCES platform.form_schema_versions (id) ON DELETE CASCADE,
    ordinal           integer NOT NULL,
    name              text NOT NULL,
    label             text,
    type              text NOT NULL,
    unit              text,
    max_length        integer,
    enum_ref          text,
    schema_mandatory  boolean NOT NULL DEFAULT false,
    mandatory_note    text,
    relevance         text,
    section           text,
    applies_to_events jsonb NOT NULL DEFAULT '[]'::jsonb,
    description       text,
    attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (schema_version_id, name)
);

CREATE INDEX IF NOT EXISTS form_schema_fields_enum_ref_idx
    ON platform.form_schema_fields (enum_ref);
CREATE INDEX IF NOT EXISTS form_schema_fields_name_idx
    ON platform.form_schema_fields (name);

CREATE TABLE IF NOT EXISTS platform.form_enums (
    enum_name  text PRIMARY KEY,
    title      text NOT NULL,
    status     text NOT NULL DEFAULT 'active',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT form_enums_status_check CHECK (status IN ('active', 'deprecated'))
);

CREATE TABLE IF NOT EXISTS platform.form_enum_versions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enum_name        text NOT NULL REFERENCES platform.form_enums (enum_name) ON DELETE CASCADE,
    version          text NOT NULL,
    ovd_version      text,
    content          jsonb NOT NULL,
    content_checksum text NOT NULL,
    status           text NOT NULL DEFAULT 'published',
    published_at     timestamp with time zone,
    published_by     text,
    created_at       timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT form_enum_versions_status_check
        CHECK (status IN ('draft', 'published', 'deprecated'))
);

CREATE UNIQUE INDEX IF NOT EXISTS form_enum_versions_name_version_key
    ON platform.form_enum_versions (enum_name, version);

CREATE TABLE IF NOT EXISTS platform.form_enum_values (
    enum_version_id uuid NOT NULL REFERENCES platform.form_enum_versions (id) ON DELETE CASCADE,
    ordinal         integer NOT NULL,
    code            text NOT NULL,
    label           text,
    description     text,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (enum_version_id, code)
);

-- ---------------------------------------------------------------------------
-- 6. The role that publishes the master catalogue
--
-- Same dormant-membership trick as tenant roles, for the same reason. ovl_api
-- is a member of platform_publisher but NOINHERIT, so the privilege exists only
-- inside a transaction that has explicitly run `SET LOCAL ROLE
-- platform_publisher` after checking the caller is a platform super admin.
--
-- A bug on an ordinary tenant request path therefore cannot write here: it
-- never assumes the role, and without assuming it the write is refused by the
-- database. NOLOGIN, so it is a privilege container and never a way in.
-- ---------------------------------------------------------------------------

SELECT format('CREATE ROLE %I NOLOGIN', 'platform_publisher')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_publisher')
\gexec

GRANT USAGE ON SCHEMA platform TO platform_publisher;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    platform.form_schemas, platform.form_schema_versions, platform.form_schema_fields,
    platform.form_enums, platform.form_enum_versions, platform.form_enum_values
    TO platform_publisher;
GRANT platform_publisher TO ovl_api;

-- Provisioning also needs to seed the catalogue from the curated files.
GRANT platform_publisher TO ovl_admin;

-- ---------------------------------------------------------------------------
-- 7. Read access to the catalogue, as a group role
--
-- Tenant roles get catalogue access by being granted THIS role, rather than by
-- provisioning issuing GRANTs on the platform tables directly. Two reasons, and
-- the second one cost a debugging session:
--
--   * One definition of "may read the catalogue". Adding a table to the
--     catalogue later is one GRANT here, not an edit to provisioning that
--     silently leaves every existing tenant behind.
--
--   * Provisioning runs as ovl_admin, which does not own the `platform` schema
--     and therefore has no grant option on it. PostgreSQL does not raise an
--     error in that case — it emits `WARNING: no privileges were granted` and
--     commits. The GRANTs looked right, ran without failing, and did nothing.
--     Handing out a role membership works because ovl_admin is given ADMIN
--     OPTION on this role below, and TenantProvisioningService now verifies the
--     result rather than trusting it.
--
-- SELECT only. This is what makes "a tenant can never change a master schema" a
-- database privilege rather than an application rule.
-- ---------------------------------------------------------------------------

SELECT format('CREATE ROLE %I NOLOGIN', 'tenant_catalogue_reader')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_catalogue_reader')
\gexec

GRANT USAGE ON SCHEMA platform TO tenant_catalogue_reader;
GRANT SELECT ON
    platform.form_schemas, platform.form_schema_versions, platform.form_schema_fields,
    platform.form_enums, platform.form_enum_versions, platform.form_enum_values
    TO tenant_catalogue_reader;

-- ADMIN OPTION is what lets provisioning hand this membership to a new tenant
-- role. Without it the GRANT would warn-and-do-nothing, exactly as above.
GRANT tenant_catalogue_reader TO ovl_admin WITH ADMIN OPTION;

-- ---------------------------------------------------------------------------
-- 8. The role that registers edge credentials
--
-- Minting a vessel API key has to write two places: the api_keys row in the
-- tenant's own schema, and the platform index that says which tenant that key
-- belongs to. The tenant role can do the first and must not be able to do the
-- second — a tenant that could write platform.edge_credentials could point
-- another tenant's key at itself.
--
-- Same dormant-membership pattern as platform_publisher: ovl_api is a member,
-- NOINHERIT keeps it inert, and it applies only inside a transaction that has
-- explicitly assumed it while minting or revoking a key.
-- ---------------------------------------------------------------------------

SELECT format('CREATE ROLE %I NOLOGIN', 'edge_registrar')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_registrar')
\gexec

GRANT USAGE ON SCHEMA platform TO edge_registrar;
GRANT SELECT, INSERT, UPDATE ON platform.edge_credentials TO edge_registrar;
GRANT edge_registrar TO ovl_api;
GRANT edge_registrar TO ovl_admin;

-- ovl_api reads the catalogue directly, without assuming any role.
--
-- Safe, and necessary. Safe because the master catalogue holds no tenant data
-- — it is the shared list of form definitions every tenant may choose from, so
-- reading it crosses no isolation boundary. Necessary because a super admin
-- browsing the catalogue has no tenant context to borrow a role from, and
-- because membership in tenant_catalogue_reader would be dormant for ovl_api
-- anyway: it is NOINHERIT, so an unassumed membership grants nothing.
--
-- SELECT only. Writing still requires assuming platform_publisher.
GRANT SELECT ON
    platform.form_schemas, platform.form_schema_versions, platform.form_schema_fields,
    platform.form_enums, platform.form_enum_versions, platform.form_enum_values
    TO ovl_api;

-- ---------------------------------------------------------------------------
-- 9. The audit log
--
-- Write mode lets a platform operator change a customer's live data with the
-- customer's own privileges. Nothing constrains what they may change while
-- that window is open, which makes this table the control on it: the record of
-- who entered whose tenant, in which mode, and what they did there.
--
-- It lives in `platform` rather than in each tenant schema for three reasons.
-- A super admin acting before any tenant is selected has no tenant schema to
-- write into. An operator who could reach a tenant's data could otherwise
-- reach the log of their own visit. And a tenant that is later archived should
-- not take the record of what was done inside it with it.
--
-- Append-only is enforced by grants, not by convention. `audit_writer` holds
-- INSERT and nothing else — not even SELECT, so a compromised write path
-- cannot read the log back out. `audit_reader` holds SELECT and nothing else.
-- No role anywhere holds UPDATE or DELETE; the only way a row ever leaves is
-- purge_expired_audit_events() below, which can only remove rows that are
-- already past their retention.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.audit_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    at            timestamp with time zone NOT NULL DEFAULT now(),

    -- Which tenant the event concerns; NULL for platform-level events that
    -- precede any tenant, such as a super admin's own sign-in.
    --
    -- ON DELETE SET NULL, never CASCADE: destroying a tenant must not destroy
    -- the record of what was done inside it, which is exactly when that record
    -- matters most. `tenant_slug` is stored alongside so the row stays
    -- readable after the tenant it names is gone.
    tenant_id     uuid REFERENCES platform.tenants (id) ON DELETE SET NULL,
    tenant_slug   text,

    -- Dotted name, e.g. 'impersonation.mode_changed'. Free text rather than an
    -- enum: a deployment running an older binary must still be able to store
    -- an event a newer one emits, and an audit log that rejects unknown events
    -- loses precisely the events worth having.
    event         text NOT NULL,

    -- Drives retention, and only that. Three classes because the retention
    -- periods are three: authentication 12 months, administrative change 24,
    -- impersonation 36.
    event_class   text NOT NULL
        CONSTRAINT audit_events_class_check
        CHECK (event_class IN ('auth', 'admin', 'impersonation')),

    -- Failures are the entries that matter most — a run of failed sign-ins is
    -- the signal — so they are first-class rows, not omissions.
    outcome       text NOT NULL DEFAULT 'success'
        CONSTRAINT audit_events_outcome_check
        CHECK (outcome IN ('success', 'failure')),

    -- Who did it. The email is denormalised on purpose: an audit row must stay
    -- legible after the identity it names has been deleted.
    actor_user_id        text,
    actor_email          text,
    actor_is_super_admin boolean NOT NULL DEFAULT false,

    -- What it was done to: a user id, a tenant slug, an API key label.
    subject       text,

    -- Anything event-specific. Deliberately schemaless — the alternative is a
    -- migration every time an event learns a new field, which in practice
    -- means the field is not recorded.
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,

    request_id    text,
    ip            text,
    user_agent    text,

    -- When this row becomes eligible for deletion. Set by the trigger below,
    -- never by the caller: retention that the writer can choose is retention
    -- that a compromised writer can set to zero.
    retain_until  timestamp with time zone NOT NULL
);

CREATE OR REPLACE FUNCTION platform.audit_events_set_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    NEW.retain_until := NEW.at + CASE NEW.event_class
        WHEN 'auth'          THEN interval '12 months'
        WHEN 'admin'         THEN interval '24 months'
        WHEN 'impersonation' THEN interval '36 months'
    END;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS audit_events_set_retention ON platform.audit_events;
CREATE TRIGGER audit_events_set_retention
    BEFORE INSERT ON platform.audit_events
    FOR EACH ROW EXECUTE FUNCTION platform.audit_events_set_retention();

-- The tenant-facing view reads (tenant_id, at); the platform-wide one reads
-- (at); "everything this operator did" reads (actor_user_id, at). The last
-- index is for the purge, which would otherwise scan the whole table.
CREATE INDEX IF NOT EXISTS audit_events_at_idx
    ON platform.audit_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_at_idx
    ON platform.audit_events (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_at_idx
    ON platform.audit_events (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_retain_until_idx
    ON platform.audit_events (retain_until);

-- The only path by which an audit row is ever removed.
--
-- SECURITY DEFINER so that DELETE on the table can stay ungranted: the
-- privilege lives in this function, and the function can only delete what has
-- already outlived its retention. Run it from a scheduled job.
CREATE OR REPLACE FUNCTION platform.purge_expired_audit_events()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = platform, pg_temp
AS $fn$
DECLARE
    removed bigint;
BEGIN
    DELETE FROM platform.audit_events WHERE retain_until <= now();
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$fn$;

REVOKE ALL ON FUNCTION platform.purge_expired_audit_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.purge_expired_audit_events() TO ovl_admin;

-- Same dormant-membership pattern as platform_publisher and edge_registrar:
-- ovl_api is a member of both roles, NOINHERIT keeps both inert, and each
-- applies only inside a transaction that has explicitly assumed it.
--
-- Two roles rather than one because writing and reading the log are different
-- privileges held by different code paths. The request path writes; only a
-- super admin, or a tenant admin looking at their own tenant's events, reads.

SELECT format('CREATE ROLE %I NOLOGIN', 'audit_writer')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer')
\gexec

GRANT USAGE ON SCHEMA platform TO audit_writer;
GRANT INSERT ON platform.audit_events TO audit_writer;
GRANT audit_writer TO ovl_api;
GRANT audit_writer TO ovl_admin;

SELECT format('CREATE ROLE %I NOLOGIN', 'audit_reader')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader')
\gexec

GRANT USAGE ON SCHEMA platform TO audit_reader;
GRANT SELECT ON platform.audit_events TO audit_reader;
-- The reader needs the registry too: an audit view names tenants, and joining
-- to platform.tenants under this role must not fall back on ovl_api's grants,
-- which are dormant while a role is assumed.
GRANT SELECT ON platform.tenants TO audit_reader;
GRANT audit_reader TO ovl_api;
GRANT audit_reader TO ovl_admin;

-- Deliberately NOT granted: SELECT to audit_writer, and UPDATE or DELETE to
-- anyone at all.

-- ---------------------------------------------------------------------------
-- 10. The role that records tenant membership
--
-- Creating a user writes two places: the profile row in the tenant's own
-- schema, and the platform mapping that says which tenant that identity
-- belongs to. Without the second, the account authenticates and then resolves
-- to no tenant at all — it can sign in, and every request after that is
-- rejected, because TenantRegistryService.forUser reads this table and finds
-- nothing.
--
-- Section 3 gives ovl_api SELECT here and no more, which is correct for
-- resolution and insufficient for creation. The privilege is therefore held by
-- a role of its own, exactly as edge_registrar and audit_writer are: ovl_api is
-- a member, NOINHERIT keeps the membership inert, and it applies only inside a
-- transaction that has explicitly assumed it while enrolling a new account.
--
-- The mapping matters as much as edge_credentials does, and for the same
-- reason. It decides which schema an identity reaches, so a request path able
-- to write it at will could move an account onto another operator's tenant.
-- Narrow, dormant and deliberate is the point.
--
-- INSERT and UPDATE, not DELETE. Enrolling an account and moving one between
-- tenants are both things the API does; unmapping an identity entirely is
-- offboarding, which stays with ovl_admin (section 4).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 11. The role that edits a tenant's own settings
--
-- A tenant's administrators may rename their company, upload their logo and
-- set their default timezone. All three live on platform.tenants, which
-- ovl_api can otherwise only read.
--
-- The grant is COLUMN-LEVEL, and that is the whole point of it. `slug`,
-- `schema_name`, `role_name` and `status` decide which schema a tenant
-- resolves to and whether it resolves at all; a request path able to write
-- those could repoint a customer at another customer's data or quietly
-- suspend them. Naming the three columns that are safe to edit means the
-- other four are refused by Postgres rather than by a validation check
-- somebody has to remember to write.
-- ---------------------------------------------------------------------------

SELECT format('CREATE ROLE %I NOLOGIN', 'tenant_settings_writer')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_settings_writer')
\gexec

GRANT USAGE ON SCHEMA platform TO tenant_settings_writer;
GRANT SELECT ON platform.tenants TO tenant_settings_writer;
GRANT UPDATE (name, logo_data_url, default_timezone) ON platform.tenants TO tenant_settings_writer;
GRANT tenant_settings_writer TO ovl_api;
GRANT tenant_settings_writer TO ovl_admin;

-- Deliberately NOT granted: UPDATE on slug, schema_name, role_name or status,
-- and INSERT or DELETE on this table at all. Creating and retiring tenants is
-- provisioning, and stays with ovl_admin (section 4).

SELECT format('CREATE ROLE %I NOLOGIN', 'tenant_membership_writer')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_membership_writer')
\gexec

GRANT USAGE ON SCHEMA platform TO tenant_membership_writer;
GRANT SELECT, INSERT, UPDATE ON platform.tenant_users TO tenant_membership_writer;
-- The INSERT has a foreign key to platform.tenants, and PostgreSQL checks it as
-- the current role. Without this the write fails with "permission denied for
-- table tenants" — an error about a table the statement never names, which is
-- an unpleasant thing to debug. ovl_api's own SELECT does not cover it, being
-- dormant while a role is assumed.
GRANT SELECT ON platform.tenants TO tenant_membership_writer;
GRANT tenant_membership_writer TO ovl_api;
GRANT tenant_membership_writer TO ovl_admin;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify (ovl_api must show rolinherit = f and rolsuper = f;
-- ovl_admin must show rolcreaterole = t and rolsuper = f):
--
--   SELECT rolname, rolinherit, rolcanlogin, rolcreaterole, rolsuper
--     FROM pg_roles WHERE rolname IN ('ovl_api', 'ovl_admin');
--
-- And confirm the bulkhead actually holds — this must FAIL:
--
--   SET ROLE ovl_api;
--   SELECT * FROM tenant_default.vessels;   -- ERROR: permission denied for schema
-- ---------------------------------------------------------------------------
