-- Control-plane bootstrap for schema-per-tenant multi-tenancy.
--
-- Run ONCE per database, as a superuser (or the database owner), before the
-- office API is started in multi-tenant mode. It is idempotent — re-running it
-- is safe and is the intended way to repair drifted grants.
--
-- Usage:
--   psql "$ADMIN_DATABASE_URL" -v api_password="$OVL_API_DB_PASSWORD" \
--        -f packages/database/bootstrap/platform-bootstrap.sql
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

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ovl_api') THEN
        EXECUTE format('CREATE ROLE ovl_api LOGIN NOINHERIT PASSWORD %L', :'api_password');
    ELSE
        EXECUTE format('ALTER ROLE ovl_api LOGIN NOINHERIT PASSWORD %L', :'api_password');
    END IF;
END
$$;

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

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify (should return NOINHERIT = false for rolinherit):
--
--   SELECT rolname, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = 'ovl_api';
--
-- And confirm the bulkhead actually holds — this must FAIL:
--
--   SET ROLE ovl_api;
--   SELECT * FROM tenant_default.vessels;   -- ERROR: permission denied for schema
-- ---------------------------------------------------------------------------
