import { pgSchema, uuid, text, timestamp, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

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
