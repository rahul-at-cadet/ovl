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
GRANT SELECT ON platform.tenants, platform.tenant_users, platform.super_admins TO ovl_api;

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
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenants, platform.tenant_users, platform.tenant_migrations, platform.super_admins TO ovl_admin;

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
