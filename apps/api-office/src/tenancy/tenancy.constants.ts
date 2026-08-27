/**
 * Injection tokens and tunables for the tenancy module.
 *
 * Kept in their own file so that a provider can be injected without importing
 * the module that defines it — the usual NestJS way of avoiding circular
 * imports between a module and the services that consume it.
 */

/** The single shared, tenant-agnostic `pg.Pool`. */
export const PG_POOL = 'OVL_PG_POOL';

/** A Drizzle handle typed against the control-plane schema ONLY. */
export const PLATFORM_DB = 'OVL_PLATFORM_DB';

/** The elevated pool used for provisioning (CREATE SCHEMA / CREATE ROLE / GRANT). */
export const ADMIN_PG_POOL = 'OVL_ADMIN_PG_POOL';

/** Resolved TenancyModuleOptions, after defaults have been applied. */
export const TENANCY_OPTIONS = 'OVL_TENANCY_OPTIONS';

export interface TenancyModuleOptions {
  /**
   * Connection string for the API's own low-privilege role (`ovl_api`).
   * This role must be NOINHERIT and must own nothing — see
   * packages/database/bootstrap/platform-bootstrap.sql.
   */
  connectionString: string;

  /**
   * Connection string for a role that may CREATE SCHEMA / CREATE ROLE / GRANT.
   * Used only by TenantProvisioningService. Omit it and provisioning is
   * disabled rather than silently attempted with insufficient rights, which
   * is the right default for a production API process.
   */
  adminConnectionString?: string;

  /** Connections per Node process. See OVL_POOL_DEFAULTS for the budgeting rule. */
  poolMax?: number;

  /** How long a request waits for a free connection before being shed. */
  connectionTimeoutMillis?: number;

  /**
   * Ceiling on concurrent database transactions for any ONE tenant.
   *
   * Schema-per-tenant isolates data, not resources — AWS is explicit that the
   * bridge model inherits the pool model's noisy-neighbour problem. This cap
   * is what stops one operator's heavy hour from queueing the shared pool and
   * degrading every other operator. Defaults to a third of the pool.
   */
  maxConcurrentPerTenant?: number;

  /**
   * How long a request waits in the per-tenant queue before being rejected.
   * Shedding beats queueing without bound: a request that times out after
   * waiting has burned a slot and returned nothing.
   */
  tenantQueueTimeoutMillis?: number;

  /** `SET LOCAL statement_timeout` applied to every tenant transaction. 0 disables. */
  statementTimeoutMillis?: number;

  /** TTL for the tenant registry lookup cache. */
  registryCacheTtlMillis?: number;
}

export const TENANCY_DEFAULTS = {
  poolMax: 15,
  connectionTimeoutMillis: 2_000,
  tenantQueueTimeoutMillis: 5_000,
  statementTimeoutMillis: 15_000,
  registryCacheTtlMillis: 30_000,
} as const;

export type ResolvedTenancyOptions = Required<
  Omit<TenancyModuleOptions, 'adminConnectionString'>
> & { adminConnectionString?: string };

export const resolveTenancyOptions = (
  options: TenancyModuleOptions,
): ResolvedTenancyOptions => {
  const poolMax = options.poolMax ?? TENANCY_DEFAULTS.poolMax;
  return {
    connectionString: options.connectionString,
    adminConnectionString: options.adminConnectionString,
    poolMax,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ?? TENANCY_DEFAULTS.connectionTimeoutMillis,
    // A third of the pool: enough that a single tenant is never artificially
    // slow on an idle system, low enough that three busy tenants cannot
    // between them starve a fourth.
    maxConcurrentPerTenant:
      options.maxConcurrentPerTenant ?? Math.max(1, Math.ceil(poolMax / 3)),
    tenantQueueTimeoutMillis:
      options.tenantQueueTimeoutMillis ?? TENANCY_DEFAULTS.tenantQueueTimeoutMillis,
    statementTimeoutMillis:
      options.statementTimeoutMillis ?? TENANCY_DEFAULTS.statementTimeoutMillis,
    registryCacheTtlMillis:
      options.registryCacheTtlMillis ?? TENANCY_DEFAULTS.registryCacheTtlMillis,
  };
};
