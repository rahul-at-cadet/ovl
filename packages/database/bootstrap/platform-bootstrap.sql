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
GRANT SELECT ON platform.tenants, platform.tenant_users TO ovl_api;

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
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenants, platform.tenant_users, platform.tenant_migrations TO ovl_admin;

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
