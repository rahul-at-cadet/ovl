-- Per-tenant form-schema tables.
--
-- Applied by TenantProvisioningService inside each new tenant schema, after
-- fresh-database.sql, with `search_path` pointed at that schema and the tenant
-- role assumed — so every table here is created unqualified and ends up owned
-- by tenant_<slug>_rw, like the rest of that tenant's tables.
--
-- Kept separate from fresh-database.sql on purpose: that file is drizzle-kit
-- output (plus one hand-correction) and is regenerated, while this one is
-- hand-written. Mixing them would mean a regeneration silently dropping this.
--
-- These tables hold what a tenant owns: schemas it uploaded itself, forks it
-- took of master schemas in order to change them, and the record of which
-- version it has adopted for each schema name. The master catalogue itself
-- lives in `platform` and is read-only to every tenant role.

CREATE TABLE IF NOT EXISTS form_schema_versions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_name            text NOT NULL,
    version                text NOT NULL,
    ovd_version            text,

    -- 'own'  — uploaded by this tenant from scratch
    -- 'fork' — copied from a master version so it could be changed
    origin                 text NOT NULL,

    -- Fork lineage. Deliberately NOT a foreign key into
    -- platform.form_schema_versions: a cross-schema FK would couple this schema
    -- to the control plane for backup, restore and per-tenant migration, and
    -- would need REFERENCES grants on tables tenants otherwise only read.
    -- Master versions are immutable and deprecated rather than deleted, so a
    -- dangling reference is not a practical risk — and the checksum says *what*
    -- diverged, which a constraint could not.
    forked_from_version_id uuid,
    forked_from_version    text,
    forked_from_checksum   text,

    content                jsonb NOT NULL,
    content_checksum       text NOT NULL,
    sections               jsonb NOT NULL DEFAULT '[]'::jsonb,
    status                 text NOT NULL DEFAULT 'draft',
    published_at           timestamp with time zone,
    published_by           text,
    created_at             timestamp with time zone NOT NULL DEFAULT now(),
    created_by             text,

    CONSTRAINT form_schema_versions_origin_check
        CHECK (origin IN ('own', 'fork')),
    CONSTRAINT form_schema_versions_status_check
        CHECK (status IN ('draft', 'published', 'deprecated')),
    -- A fork that cannot say what it forked from is not a fork; it is an
    -- untraceable copy, and the upgrade path depends on this lineage.
    CONSTRAINT form_schema_versions_fork_lineage_check
        CHECK (origin <> 'fork' OR forked_from_version_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS form_schema_versions_name_version_key
    ON form_schema_versions (schema_name, version);
CREATE INDEX IF NOT EXISTS form_schema_versions_checksum_idx
    ON form_schema_versions (content_checksum);
CREATE INDEX IF NOT EXISTS form_schema_versions_fork_idx
    ON form_schema_versions (forked_from_version_id);

CREATE TABLE IF NOT EXISTS form_schema_fields (
    schema_version_id uuid NOT NULL REFERENCES form_schema_versions (id) ON DELETE CASCADE,
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
    ON form_schema_fields (enum_ref);

-- The opt-in.
--
-- Primary key on schema_name means exactly one version is active per schema for
-- this tenant. Same reasoning as platform.tenant_users: an ambiguous "which one
-- did they mean?" is where the wrong answer gets served.
--
-- No row means the schema is simply not available to this tenant. There is
-- deliberately no implicit fallback to the master catalogue — a silent default
-- would let a super admin change what a tenant's crews see without the tenant
-- ever agreeing to it, which is the opposite of the intended model.
CREATE TABLE IF NOT EXISTS form_schema_adoptions (
    schema_name       text PRIMARY KEY,
    source            text NOT NULL,

    -- Populated when source = 'master'. The version and checksum are carried
    -- alongside the id so "is our adopted copy still what master says?" is
    -- answerable without reaching into platform — which is what drives both the
    -- vessel sync diff and the "upgrade available" prompt.
    master_version_id uuid,
    master_version    text,
    master_checksum   text,

    -- Populated when source = 'tenant'. RESTRICT rather than CASCADE: deleting
    -- the version a tenant is actively using should fail loudly, not silently
    -- leave its crews with no form.
    tenant_version_id uuid REFERENCES form_schema_versions (id) ON DELETE RESTRICT,

    adopted_at        timestamp with time zone NOT NULL DEFAULT now(),
    adopted_by        text,

    CONSTRAINT form_schema_adoptions_source_check
        CHECK (source IN ('master', 'tenant')),
    CONSTRAINT form_schema_adoptions_one_source_check CHECK (
        (source = 'master' AND master_version_id IS NOT NULL AND tenant_version_id IS NULL)
        OR
        (source = 'tenant' AND tenant_version_id IS NOT NULL AND master_version_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS form_schema_adoptions_source_idx
    ON form_schema_adoptions (source);
