import { pgTable, uuid, text, timestamp, index, uniqueIndex, primaryKey, jsonb, integer, boolean } from 'drizzle-orm/pg-core';

/**
 * A tenant's own form schemas, and its adoptions of the master catalogue.
 *
 * Declared with bare `pgTable`, unqualified, exactly like the rest of
 * `schema.ts` — so these definitions resolve into whichever tenant schema
 * `search_path` currently names. The master catalogue they refer to is in
 * `platform-schema.ts` and is qualified, because it must resolve to one place
 * for everybody.
 *
 * The model, in one sentence: a super admin publishes into the master
 * catalogue, a tenant chooses whether to adopt each schema, and a tenant that
 * wants changes forks a copy into its own schema rather than editing the
 * master — which it could not do anyway, since tenant roles hold only SELECT
 * on `platform`.
 *
 * The TypeScript names here are prefixed `tenant*` only to avoid colliding with
 * the platform exports in the package barrel. The SQL table names are
 * unprefixed; there is no ambiguity in the database because the two sets live
 * in different schemas.
 */

export const FORM_SCHEMA_ORIGINS = ['own', 'fork'] as const;
export type FormSchemaOrigin = (typeof FORM_SCHEMA_ORIGINS)[number];

export const FORM_ADOPTION_SOURCES = ['master', 'tenant'] as const;
export type FormAdoptionSource = (typeof FORM_ADOPTION_SOURCES)[number];

/**
 * Versions this tenant owns: schemas it uploaded itself (`own`) and copies it
 * took of a master schema in order to change it (`fork`).
 *
 * Immutable once published, same rule as the master catalogue: supersede,
 * never rewrite. Reports pin the version they were captured under, so editing
 * a published version in place would retroactively change what already-
 * collected data means.
 */
export const tenantFormSchemaVersions = pgTable(
  'form_schema_versions',
  {
    id: uuid('id').primaryKey().defaultRandom().notNull(),
    schemaName: text('schema_name').notNull(),
    version: text('version').notNull(),
    ovdVersion: text('ovd_version'),
    origin: text('origin').notNull(),

    /**
     * Fork lineage. Deliberately NOT a foreign key into
     * `platform.form_schema_versions`.
     *
     * A cross-schema FK would work, but it couples every tenant schema to
     * `platform` for backup, restore and per-tenant migration, and it needs
     * REFERENCES grants on control-plane tables that tenants otherwise only
     * read. Master versions are immutable and are deprecated rather than
     * deleted, so a dangling reference is not a practical risk — and the
     * checksum below detects any mismatch far more usefully than a constraint
     * would, because it can say *what* diverged.
     *
     * This is what later answers the upgrade question: master has shipped
     * 3.14, this tenant forked at 3.13, what did they change and does it
     * conflict?
     */
    forkedFromVersionId: uuid('forked_from_version_id'),
    forkedFromVersion: text('forked_from_version'),
    forkedFromChecksum: text('forked_from_checksum'),

    content: jsonb('content').notNull(),
    /** SHA-256 over canonical (sorted-key) JSON. See formSchemaChecksum(). */
    contentChecksum: text('content_checksum').notNull(),
    sections: jsonb('sections').notNull().default([]),
    status: text('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    publishedBy: text('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    createdBy: text('created_by'),
  },
  (table) => {
    return {
      tenantFormSchemaVersionsNameVersionKey: uniqueIndex('form_schema_versions_name_version_key').on(
        table.schemaName,
        table.version,
      ),
      tenantFormSchemaVersionsChecksumIdx: index('form_schema_versions_checksum_idx').on(table.contentChecksum),
      tenantFormSchemaVersionsForkIdx: index('form_schema_versions_fork_idx').on(table.forkedFromVersionId),
    };
  },
);

/** Field projection for a tenant-owned version. Mirrors the platform table. */
export const tenantFormSchemaFields = pgTable(
  'form_schema_fields',
  {
    schemaVersionId: uuid('schema_version_id')
      .notNull()
      .references(() => tenantFormSchemaVersions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    label: text('label'),
    type: text('type').notNull(),
    unit: text('unit'),
    maxLength: integer('max_length'),
    enumRef: text('enum_ref'),
    schemaMandatory: boolean('schema_mandatory').notNull().default(false),
    mandatoryNote: text('mandatory_note'),
    relevance: text('relevance'),
    section: text('section'),
    appliesToEvents: jsonb('applies_to_events').notNull().default([]),
    description: text('description'),
    attributes: jsonb('attributes').notNull().default({}),
  },
  (table) => {
    return {
      tenantFormSchemaFieldsPkey: primaryKey({ columns: [table.schemaVersionId, table.name] }),
      tenantFormSchemaFieldsEnumRefIdx: index('form_schema_fields_enum_ref_idx').on(table.enumRef),
    };
  },
);

/**
 * Which version of each schema this tenant actually uses — the opt-in.
 *
 * Primary-keyed on `schema_name`, so exactly one version is active per schema
 * per tenant. That is the same reasoning as `platform.tenant_users`: an
 * ambiguous "which one did they mean?" is precisely where the wrong answer
 * gets served. A schema with no row here is simply not available to this
 * tenant — there is no implicit fallback to the master catalogue, because a
 * silent default would mean a super admin could change what a tenant's crews
 * see without the tenant ever agreeing to it.
 *
 * `master_version` and `master_checksum` are denormalised alongside the id so
 * that "is our adopted copy still what the master says it is?" is answerable
 * without reaching into `platform` — useful for the vessel sync diff and for
 * showing a tenant that an upgrade is available.
 */
export const formSchemaAdoptions = pgTable(
  'form_schema_adoptions',
  {
    schemaName: text('schema_name').primaryKey().notNull(),
    /** 'master' — using the catalogue version as-is. 'tenant' — using our own or a fork. */
    source: text('source').notNull(),

    masterVersionId: uuid('master_version_id'),
    masterVersion: text('master_version'),
    masterChecksum: text('master_checksum'),

    tenantVersionId: uuid('tenant_version_id').references(() => tenantFormSchemaVersions.id, {
      onDelete: 'restrict',
    }),

    adoptedAt: timestamp('adopted_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    adoptedBy: text('adopted_by'),
  },
  (table) => {
    return {
      formSchemaAdoptionsSourceIdx: index('form_schema_adoptions_source_idx').on(table.source),
    };
  },
);

export type TenantFormSchemaVersionRow = typeof tenantFormSchemaVersions.$inferSelect;
export type TenantFormSchemaFieldRow = typeof tenantFormSchemaFields.$inferSelect;
export type FormSchemaAdoptionRow = typeof formSchemaAdoptions.$inferSelect;
