import { pgSchema, uuid, text, timestamp, index, uniqueIndex, primaryKey, jsonb, integer, boolean } from "drizzle-orm/pg-core";

/**
 * The control-plane schema.
 *
 * Everything in here describes *which* tenants exist and how to reach them.
 * No tenant's business data ever lives here — that is the whole point of the
 * separation. `packages/database/src/schema.ts` holds the per-tenant tables,
 * and those are deliberately declared unqualified (bare `pgTable(...)`, never
 * `pgSchema(...).table(...)`) so that a single set of definitions resolves
 * into whichever tenant schema `search_path` currently names.
 *
 * These tables, by contrast, ARE qualified. They must resolve to the same
 * place on every request regardless of the active tenant, so they can never
 * be allowed to ride the search_path.
 */
export const PLATFORM_SCHEMA_NAME = "platform";

export const platform = pgSchema(PLATFORM_SCHEMA_NAME);

/**
 * A tenant's lifecycle.
 *
 * `provisioning` exists so that a half-built tenant — schema created, tables
 * not yet migrated — can never be resolved and served. Only `active` tenants
 * are ever handed to a request; see TenantRegistryService.
 */
export const TENANT_STATUSES = ["provisioning", "active", "suspended", "archived"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const tenants = platform.table(
	"tenants",
	{
		id: uuid("id").primaryKey().defaultRandom().notNull(),
		/** Human-facing, URL-safe key. Also the stem for schemaName and roleName. */
		slug: text("slug").notNull(),
		/** Display name, e.g. "Northstar Shipping". Never used to build SQL. */
		name: text("name").notNull(),
		/** Always `tenant_<slug>`. Stored rather than derived so a rename can never silently repoint a live tenant. */
		schemaName: text("schema_name").notNull(),
		/** Always `tenant_<slug>_rw`. The role the pool assumes for this tenant's transactions. */
		roleName: text("role_name").notNull(),
		status: text("status").notNull().default("provisioning"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => {
		return {
			tenantsSlugKey: uniqueIndex("tenants_slug_key").on(table.slug),
			tenantsSchemaNameKey: uniqueIndex("tenants_schema_name_key").on(table.schemaName),
			tenantsStatusIdx: index("tenants_status_idx").on(table.status),
		};
	},
);

/**
 * Maps an authenticated identity to exactly one tenant.
 *
 * The primary key is the SuperTokens user id, not a composite — one identity
 * resolves to one tenant, full stop. That is a deliberate security property
 * rather than a modelling shortcut: if a user could belong to several tenants,
 * every request would need to *choose* one, and a caller-influenced choice is
 * precisely the hole this design exists to close.
 *
 * To support multi-tenant users later, do NOT relax this to a composite key
 * and pick the first row. Add a separate `tenant_memberships` table for the
 * many-to-many relation and keep this table as the single unambiguous
 * "active tenant" pointer, switched only by an explicit, audited action.
 */
export const tenantUsers = platform.table(
	"tenant_users",
	{
		supertokensUserId: text("supertokens_user_id").primaryKey().notNull(),
		tenantId: uuid("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => {
		return {
			tenantUsersTenantIdIdx: index("tenant_users_tenant_id_idx").on(table.tenantId),
		};
	},
);

/**
 * Per-schema migration ledger.
 *
 * Schema-per-tenant means every DDL change fans out across N schemas, and a
 * fan-out that dies half way through must be resumable rather than restarted.
 * Recording state per (tenant, version) lets the runner skip what is already
 * applied and makes "which tenants are behind?" a query instead of a guess.
 */
export const tenantMigrations = platform.table(
	"tenant_migrations",
	{
		tenantId: uuid("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		version: text("version").notNull(),
		checksum: text("checksum"),
		appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => {
		return {
			tenantMigrationsPkey: primaryKey({ columns: [table.tenantId, table.version] }),
		};
	},
);

export type TenantRow = typeof tenants.$inferSelect;
export type TenantUserRow = typeof tenantUsers.$inferSelect;
export type TenantMigrationRow = typeof tenantMigrations.$inferSelect;

// ---------------------------------------------------------------------------
// Master form-schema catalogue
//
// Published by a platform super admin and readable by every tenant. This lives
// in `platform`, not in a tenant schema, for the same reason the registry does:
// it must resolve to one place regardless of which tenant is active.
//
// Tenants get GRANT SELECT here and nothing else, so "a tenant can never change
// a master schema" is a Postgres privilege rather than an application rule — an
// UPDATE is `permission denied`, not a code review question. Writes go through
// the `platform_publisher` role, which ovl_api holds only as a dormant
// membership and assumes inside a transaction after checking the caller is a
// super admin (see platform-bootstrap.sql).
//
// A tenant that wants to change a master schema forks it: the content is copied
// into that tenant's own form_schema_versions and the adoption is repointed at
// the copy. The master row is never touched.
// ---------------------------------------------------------------------------

export const FORM_SCHEMA_STATUSES = ['draft', 'published', 'deprecated'] as const;
export type FormSchemaStatus = (typeof FORM_SCHEMA_STATUSES)[number];

/** Identity of a form schema, independent of any particular version. */
export const formSchemas = platform.table('form_schemas', {
	schemaName: text('schema_name').primaryKey().notNull(),
	title: text('title').notNull(),
	description: text('description'),
	/** `deprecated` hides it from new adoptions without breaking existing ones. */
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

/**
 * An immutable published version.
 *
 * Never UPDATE a row here once published — supersede it with a new version.
 * Tenants pin their adoption to a specific version id, and reports reference
 * the version they were captured under; mutating a published version would
 * silently rewrite the meaning of data already collected against it.
 */
export const formSchemaVersions = platform.table(
	'form_schema_versions',
	{
		id: uuid('id').primaryKey().defaultRandom().notNull(),
		schemaName: text('schema_name')
			.notNull()
			.references(() => formSchemas.schemaName, { onDelete: 'cascade' }),
		version: text('version').notNull(),
		/** e.g. "3.13" — the OVD spec revision this was authored against. */
		ovdVersion: text('ovd_version'),
		/**
		 * The whole schema document, as jsonb rather than the bytea the old
		 * `schema_versions` table used. jsonb makes "which schemas reference
		 * fuel-types?" a query instead of a deserialise-every-row loop, and
		 * Postgres validates that it is actually JSON on the way in.
		 */
		content: jsonb('content').notNull(),
		/**
		 * SHA-256 over the *canonical* (sorted-key, no-whitespace) serialisation,
		 * so office and vessel agree on identity without needing byte-identical
		 * transport. This is what the vessel sends to ask "do I already have it?".
		 */
		contentChecksum: text('content_checksum').notNull(),
		sections: jsonb('sections').notNull().default([]),
		status: text('status').notNull().default('published'),
		publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
		publishedBy: text('published_by'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	},
	(table) => {
		return {
			formSchemaVersionsNameVersionKey: uniqueIndex('form_schema_versions_name_version_key').on(
				table.schemaName,
				table.version,
			),
			formSchemaVersionsChecksumIdx: index('form_schema_versions_checksum_idx').on(table.contentChecksum),
			formSchemaVersionsStatusIdx: index('form_schema_versions_status_idx').on(table.status),
		};
	},
);

/**
 * The fields of a version, projected into rows.
 *
 * A derived index over `content`, rebuilt on publish and never edited directly
 * — `content` stays the source of truth. The projection is what makes the
 * catalogue answerable: which schemas use a given enum, what changed between
 * two versions, which fields are mandatory for MRV. None of that is reachable
 * while the document is an opaque blob.
 */
export const formSchemaFields = platform.table(
	'form_schema_fields',
	{
		schemaVersionId: uuid('schema_version_id')
			.notNull()
			.references(() => formSchemaVersions.id, { onDelete: 'cascade' }),
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
		/**
		 * Anything the OVD spec adds later that has no column yet. Without this
		 * escape hatch every new field property is a migration across the
		 * catalogue and every tenant schema; with it, the projection keeps
		 * round-tripping unknown properties instead of silently dropping them.
		 */
		attributes: jsonb('attributes').notNull().default({}),
	},
	(table) => {
		return {
			formSchemaFieldsPkey: primaryKey({ columns: [table.schemaVersionId, table.name] }),
			formSchemaFieldsEnumRefIdx: index('form_schema_fields_enum_ref_idx').on(table.enumRef),
			formSchemaFieldsNameIdx: index('form_schema_fields_name_idx').on(table.name),
		};
	},
);

/** Identity of a curated enum (`fuel-types`, `event-types`, ...). */
export const formEnums = platform.table('form_enums', {
	enumName: text('enum_name').primaryKey().notNull(),
	title: text('title').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const formEnumVersions = platform.table(
	'form_enum_versions',
	{
		id: uuid('id').primaryKey().defaultRandom().notNull(),
		enumName: text('enum_name')
			.notNull()
			.references(() => formEnums.enumName, { onDelete: 'cascade' }),
		version: text('version').notNull(),
		ovdVersion: text('ovd_version'),
		content: jsonb('content').notNull(),
		contentChecksum: text('content_checksum').notNull(),
		status: text('status').notNull().default('published'),
		publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
		publishedBy: text('published_by'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	},
	(table) => {
		return {
			formEnumVersionsNameVersionKey: uniqueIndex('form_enum_versions_name_version_key').on(
				table.enumName,
				table.version,
			),
		};
	},
);

/**
 * Enum codes, projected into rows.
 *
 * The curated enum documents do not share a shape — some carry
 * `{code,label}`, others `{code,remark,fixedSpelling}` or
 * `{code,description,imo0170...}`, and `offshore-modes` uses `modes`/
 * `activities` with no `values` array at all. The vessel's current file-based
 * loader silently skips whatever it cannot parse, which is why log-abstract's
 * offshore-mode field degrades to free text today. Normalising on import gives
 * every enum one queryable shape, with `attributes` holding whatever was
 * specific to that document.
 */
export const formEnumValues = platform.table(
	'form_enum_values',
	{
		enumVersionId: uuid('enum_version_id')
			.notNull()
			.references(() => formEnumVersions.id, { onDelete: 'cascade' }),
		ordinal: integer('ordinal').notNull(),
		code: text('code').notNull(),
		label: text('label'),
		description: text('description'),
		attributes: jsonb('attributes').notNull().default({}),
	},
	(table) => {
		return {
			formEnumValuesPkey: primaryKey({ columns: [table.enumVersionId, table.code] }),
		};
	},
);

export type FormSchemaRow = typeof formSchemas.$inferSelect;
export type FormSchemaVersionRow = typeof formSchemaVersions.$inferSelect;
export type FormSchemaFieldRow = typeof formSchemaFields.$inferSelect;
export type FormEnumRow = typeof formEnums.$inferSelect;
export type FormEnumVersionRow = typeof formEnumVersions.$inferSelect;
export type FormEnumValueRow = typeof formEnumValues.$inferSelect;
