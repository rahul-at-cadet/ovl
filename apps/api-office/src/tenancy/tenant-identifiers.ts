/**
 * Naming and validation for tenant SQL identifiers.
 *
 * Postgres cannot parameterise an identifier — `SET LOCAL ROLE $1` is not a
 * thing — so schema and role names must be interpolated into SQL text. That
 * makes this file the narrowest and most security-sensitive part of the
 * tenancy code, which is why it is pure functions with no I/O: it can be
 * exhaustively unit tested, and nothing else in the codebase is allowed to
 * build a tenant identifier by hand.
 *
 * Two independent defences apply at the point of use (see TenantDbService):
 * every identifier is checked against the patterns below, AND passed through
 * `pg.escapeIdentifier`. The regexes are the real guarantee; the escaping is
 * there for the case where the regexes are one day loosened by someone who
 * did not read this comment.
 */

/** Prefix on every tenant schema. Also keeps tenant schemas visually sorted together in psql. */
export const TENANT_SCHEMA_PREFIX = 'tenant_';

/** Suffix on the read/write role that owns access to a tenant schema. */
export const TENANT_ROLE_SUFFIX = '_rw';

/**
 * A tenant slug: lowercase, starts with a letter, 2-41 characters.
 *
 * Kept well inside Postgres's 63-byte identifier limit so that both
 * `tenant_<slug>` and `tenant_<slug>_rw` fit without truncation — silent
 * truncation would let two distinct tenants collapse onto one schema.
 */
export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

/** Shape of a schema name that this application is willing to put into SQL. */
export const TENANT_SCHEMA_PATTERN = /^tenant_[a-z0-9_]{1,48}$/;

/** Shape of a role name that this application is willing to put into SQL. */
export const TENANT_ROLE_PATTERN = /^tenant_[a-z0-9_]{1,48}_rw$/;

/**
 * Reserved slugs. `template` backs the provisioning template schema and
 * `default` is the single-tenant migration target, so neither may be claimed
 * by a real customer.
 */
export const RESERVED_TENANT_SLUGS: readonly string[] = ['template', 'default', 'platform', 'public', 'admin'];

export class InvalidTenantIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantIdentifierError';
  }
}

export const isValidTenantSlug = (slug: string): boolean =>
  TENANT_SLUG_PATTERN.test(slug) && !RESERVED_TENANT_SLUGS.includes(slug);

export const isValidTenantSchemaName = (schemaName: string): boolean =>
  TENANT_SCHEMA_PATTERN.test(schemaName);

export const isValidTenantRoleName = (roleName: string): boolean =>
  TENANT_ROLE_PATTERN.test(roleName);

export function assertValidTenantSlug(slug: string): void {
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new InvalidTenantIdentifierError(
      `Tenant slug must match ${TENANT_SLUG_PATTERN} (got ${JSON.stringify(slug)})`,
    );
  }
  if (RESERVED_TENANT_SLUGS.includes(slug)) {
    throw new InvalidTenantIdentifierError(`Tenant slug ${JSON.stringify(slug)} is reserved`);
  }
}

/**
 * Guards the schema name immediately before it becomes SQL.
 *
 * Called on every single tenant transaction rather than only at provisioning
 * time. That is intentional: the registry row could have been written by an
 * older version of this code, restored from a backup, or edited by hand.
 */
export function assertValidTenantSchemaName(schemaName: string): void {
  if (!TENANT_SCHEMA_PATTERN.test(schemaName)) {
    throw new InvalidTenantIdentifierError(
      `Refusing to use schema name ${JSON.stringify(schemaName)}: does not match ${TENANT_SCHEMA_PATTERN}`,
    );
  }
}

export function assertValidTenantRoleName(roleName: string): void {
  if (!TENANT_ROLE_PATTERN.test(roleName)) {
    throw new InvalidTenantIdentifierError(
      `Refusing to use role name ${JSON.stringify(roleName)}: does not match ${TENANT_ROLE_PATTERN}`,
    );
  }
}

export const schemaNameForSlug = (slug: string): string => {
  assertValidTenantSlug(slug);
  return `${TENANT_SCHEMA_PREFIX}${slug}`;
};

export const roleNameForSlug = (slug: string): string => {
  assertValidTenantSlug(slug);
  return `${TENANT_SCHEMA_PREFIX}${slug}${TENANT_ROLE_SUFFIX}`;
};

/**
 * Best-effort normalisation for operator input ("Northstar Shipping" ->
 * "northstar_shipping"). The result is still validated before use — this is a
 * convenience for the provisioning CLI, not a sanitiser.
 */
export const slugify = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 41);
