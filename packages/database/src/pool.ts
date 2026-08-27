import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as platformSchema from './platform-schema.js';

/**
 * Pool defaults for the multi-tenant office API.
 *
 * There is exactly ONE pool per Node process, shared by every tenant. That is
 * only safe — and only possible — because tenant selection is transaction
 * scoped (`SET LOCAL ROLE` + `set_config('search_path', ..., true)`), so a
 * connection sitting idle in the pool belongs to no tenant at all and is
 * freely reusable by the next request whoever it is for.
 *
 * A pool per tenant would multiply idle connections by tenant count against a
 * fixed `max_connections`, which is the well-documented failure mode of
 * schema-per-tenant designs. Do not add one.
 */
export interface OvlPoolOptions {
  connectionString: string;
  /**
   * Connections per Node process. Budget this: total server connections are
   * `API instances x Node processes x max`, and that has to fit inside
   * Postgres `max_connections` with headroom for migrations and monitoring.
   */
  max?: number;
  /**
   * How long a request will wait for a free connection before failing.
   *
   * node-postgres defaults this to 0, meaning "wait forever". Under overload
   * that turns pool exhaustion into an unbounded queue of hanging requests.
   * We always set it so exhaustion surfaces as a fast, sheddable error.
   */
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  /** Rotate connections so a long-lived process can't pin a bad backend forever. */
  maxLifetimeSeconds?: number;
  maxUses?: number;
  /**
   * Backstop for a transaction that was opened and then abandoned. Without it
   * a wedged `withTenant` call holds a connection — and its tenant-scoped
   * role — until the process restarts.
   */
  idleInTransactionSessionTimeoutMillis?: number;
  /** Shows up in `pg_stat_activity`, which is how you find the noisy process. */
  applicationName?: string;
}

export const OVL_POOL_DEFAULTS = {
  max: 15,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 1_800,
  maxUses: 7_500,
  idleInTransactionSessionTimeoutMillis: 30_000,
  applicationName: 'ovl-api-office',
} as const;

export const buildPoolConfig = (options: OvlPoolOptions): PoolConfig => ({
  connectionString: options.connectionString,
  max: options.max ?? OVL_POOL_DEFAULTS.max,
  connectionTimeoutMillis:
    options.connectionTimeoutMillis ?? OVL_POOL_DEFAULTS.connectionTimeoutMillis,
  idleTimeoutMillis: options.idleTimeoutMillis ?? OVL_POOL_DEFAULTS.idleTimeoutMillis,
  maxLifetimeSeconds: options.maxLifetimeSeconds ?? OVL_POOL_DEFAULTS.maxLifetimeSeconds,
  maxUses: options.maxUses ?? OVL_POOL_DEFAULTS.maxUses,
  idle_in_transaction_session_timeout:
    options.idleInTransactionSessionTimeoutMillis ??
    OVL_POOL_DEFAULTS.idleInTransactionSessionTimeoutMillis,
  application_name: options.applicationName ?? OVL_POOL_DEFAULTS.applicationName,
});

export const createPool = (options: OvlPoolOptions): Pool => new Pool(buildPoolConfig(options));

/**
 * A Drizzle handle bound to the control-plane schema only.
 *
 * Deliberately typed against `platformSchema` and nothing else: code holding
 * this handle can read the tenant registry and cannot so much as name a
 * tenant table. Tenant data is reachable only through TenantDbService.
 */
export const createPlatformDb = (pool: Pool) => drizzle(pool, { schema: platformSchema });

export type PlatformDatabase = ReturnType<typeof createPlatformDb>;
