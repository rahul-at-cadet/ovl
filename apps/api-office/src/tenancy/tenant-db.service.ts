import { Inject, Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@ovl/database';
import { PG_POOL, TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';
import { currentTenantReadOnly, currentTenant } from './tenant-context';
import type { TenantDescriptor } from './tenant-registry.service';
import {
  assertValidTenantRoleName,
  assertValidTenantSchemaName,
} from './tenant-identifiers';
import { TenantConcurrencyService } from './tenant-concurrency.service';

/**
 * A Drizzle handle bound to one tenant for the life of one transaction.
 *
 * Structurally identical to the old global `DATABASE_CONNECTION` handle, so
 * existing repository code moves across unchanged — the difference is entirely
 * in which schema the unqualified table names in `@ovl/database` resolve to.
 */
export type TenantDatabase = NodePgDatabase<typeof schema>;

export interface WithTenantOptions {
  /**
   * Adds `SET LOCAL transaction_read_only = on`. Worth using for query paths:
   * it makes an accidental write fail at the database rather than succeed
   * against the wrong schema.
   */
  readOnly?: boolean;
  /** Overrides the module-wide statement timeout for one call. 0 disables. */
  statementTimeoutMillis?: number;
}

/**
 * The transaction currently bound to this async path, if any.
 *
 * Separate from the tenant context because they answer different questions:
 * that one says *which* tenant, this one says *whether a connection is already
 * held*. Kept module-private so nothing outside this service can get at a live
 * transaction handle.
 */
const activeTransaction = new AsyncLocalStorage<{ tenantId: string; db: TenantDatabase }>();

export class TenantBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantBindingError';
  }
}

/**
 * The only door to tenant data.
 *
 * Every tenant query runs inside a transaction that first binds the connection
 * to that tenant and nothing else:
 *
 *   BEGIN
 *   SET LOCAL ROLE tenant_acme_rw      -- authorisation: what may be reached
 *   SET LOCAL search_path TO tenant_acme  -- resolution: what unqualified names mean
 *   SET LOCAL statement_timeout = 15000
 *   ... work ...
 *   COMMIT                             -- both settings revert here, automatically
 *
 * `SET LOCAL` is the load-bearing word. Session-level `SET` would survive
 * `client.release()` and travel back into the pool, so the next request to
 * borrow that connection would inherit the previous tenant's role and schema —
 * the exact leak this design exists to prevent, and one that appears only
 * under concurrency, which is to say only in production. Transaction-scoped
 * settings cannot outlive the transaction even if this process crashes mid-way.
 *
 * The role is the enforcement and the search_path is only the convenience. If
 * the search_path were somehow wrong, the role still denies access to any
 * other tenant's schema. If the role were somehow wrong, that is a hard
 * failure rather than a silent redirect, because `ovl_api` is NOINHERIT and
 * owns nothing (see packages/database/bootstrap/platform-bootstrap.sql).
 */
@Injectable()
export class TenantDbService {
  private readonly logger = new Logger(TenantDbService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
    private readonly concurrency: TenantConcurrencyService,
  ) {}

  /**
   * Runs `fn` against the tenant on the current async context.
   *
   * Throws MissingTenantContextError when there is no tenant — never falls
   * back to a default. This is the normal entry point for controllers,
   * services and tRPC procedures.
   */
  async withTenant<T>(
    fn: (db: TenantDatabase) => Promise<T>,
    options: WithTenantOptions = {},
  ): Promise<T> {
    return this.runFor(currentTenant(), fn, options);
  }

  /**
   * Runs `fn` against an explicitly named tenant.
   *
   * For work with no request behind it: scheduled jobs, queue consumers,
   * migration fan-out, CLI commands. Callers must pass a descriptor obtained
   * from TenantRegistryService — never one assembled from user input.
   */
  async runFor<T>(
    tenant: TenantDescriptor,
    fn: (db: TenantDatabase) => Promise<T>,
    options: WithTenantOptions = {},
  ): Promise<T> {
    // Reentrant: a nested call joins the transaction already open on this path
    // rather than taking a second connection.
    //
    // This is not an optimisation, it is deadlock avoidance. Services call one
    // another — VesselsService asks ComplianceService for cadence rules
    // mid-method — and if each opened its own transaction, a request would hold
    // one connection while queueing for another. With a per-tenant concurrency
    // cap in front of the pool, enough such requests deadlock: every slot held
    // by someone waiting for a slot. Joining also makes the nested work atomic
    // with its caller, which is what a reader would assume anyway.
    const open = activeTransaction.getStore();
    if (open) {
      if (open.tenantId !== tenant.tenantId) {
        // Two tenants on one async path means something has gone badly wrong
        // upstream. Refuse rather than silently running B's query on A's
        // connection.
        throw new TenantBindingError(
          `Refusing to nest a transaction for tenant ${tenant.slug} inside one already ` +
            `open for a different tenant.`,
        );
      }
      // `readOnly` and `statementTimeoutMillis` belong to the outer
      // transaction and cannot be tightened here; a nested read inside an
      // outer write simply runs in the outer transaction.
      return fn(open.db);
    }

    // Re-validated here, at the last possible moment before these strings
    // become SQL, rather than trusted from the registry. Cheap, and it means
    // no future caller can route around the check by building a descriptor
    // some other way.
    assertValidTenantSchemaName(tenant.schemaName);
    assertValidTenantRoleName(tenant.roleName);

    // Read-only is the union of what the caller asked for and what the request
    // carries. A super admin viewing a tenant in read mode sets it on the
    // context, and no service below can clear it — which is the point: the
    // guarantee cannot depend on every call site remembering.
    const effective: WithTenantOptions = {
      ...options,
      readOnly: options.readOnly || currentTenantReadOnly(),
    };

    return this.concurrency.run(tenant.tenantId, () => this.runBound(tenant, fn, effective));
  }

  /** Pool telemetry, for a health endpoint or a saturation alert. */
  poolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  private async runBound<T>(
    tenant: TenantDescriptor,
    fn: (db: TenantDatabase) => Promise<T>,
    options: WithTenantOptions,
  ): Promise<T> {
    const client = await this.pool.connect();
    let bound = false;

    try {
      await this.bind(client, tenant, options);
      bound = true;

      const db = drizzle(client, { schema });
      const result = await activeTransaction.run({ tenantId: tenant.tenantId, db }, () => fn(db));

      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      await this.rollbackAndRelease(client, bound, tenant, error);
      throw error;
    }
  }

  /**
   * Binds the connection to one tenant and proves it took effect.
   *
   * Sent as a single multi-statement simple query so the whole preamble costs
   * one network round trip rather than four — this runs on every request, so
   * the difference is not academic.
   *
   * The trailing SELECT is the proof step. Without it we would be assuming the
   * preamble worked; with it, a bind that silently did not apply becomes an
   * exception on this request instead of a query that quietly reads whatever
   * schema the connection happened to be pointing at.
   */
  private async bind(
    client: PoolClient,
    tenant: TenantDescriptor,
    options: WithTenantOptions,
  ): Promise<void> {
    const role = escapeIdentifier(tenant.roleName);
    const schemaName = escapeIdentifier(tenant.schemaName);
    const timeout = options.statementTimeoutMillis ?? this.options.statementTimeoutMillis;

    const preamble = [
      'BEGIN',
      `SET LOCAL ROLE ${role}`,
      `SET LOCAL search_path TO ${schemaName}`,
      timeout > 0 ? `SET LOCAL statement_timeout = ${Number(timeout)}` : null,
      options.readOnly ? 'SET LOCAL transaction_read_only = on' : null,
      'SELECT current_user AS bound_role, current_schema() AS bound_schema',
    ]
      .filter(Boolean)
      .join('; ');

    const results = (await client.query(preamble)) as unknown as Array<{
      rows: Array<{ bound_role: string; bound_schema: string }>;
    }>;

    const verification = Array.isArray(results) ? results[results.length - 1] : results;
    const observed = verification?.rows?.[0];

    if (observed?.bound_role !== tenant.roleName || observed?.bound_schema !== tenant.schemaName) {
      throw new TenantBindingError(
        `Refusing to run: expected role/schema ${tenant.roleName}/${tenant.schemaName}, ` +
          `connection reports ${observed?.bound_role}/${observed?.bound_schema}`,
      );
    }
  }

  /**
   * Unwinds a failed transaction, destroying the connection if unwinding fails.
   *
   * `client.release(err)` with a truthy argument tells node-postgres to
   * destroy the socket rather than return it to the pool. That is the correct
   * response to a failed ROLLBACK: the connection's session state is now
   * unknown, and an unknown connection handed back to a shared pool is exactly
   * how one tenant's settings reach another tenant's request. Losing a
   * connection costs a reconnect; keeping a dirty one costs a data leak.
   */
  private async rollbackAndRelease(
    client: PoolClient,
    bound: boolean,
    tenant: TenantDescriptor,
    cause: unknown,
  ): Promise<void> {
    if (!bound) {
      // The preamble itself failed, so no transaction is reliably open and the
      // connection's state cannot be reasoned about. Do not reuse it.
      client.release(true);
      return;
    }

    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      this.logger.error(
        `ROLLBACK failed for tenant ${tenant.slug}; destroying connection rather than ` +
          `returning it to the pool. Original error: ${String(cause)}`,
        rollbackError instanceof Error ? rollbackError.stack : undefined,
      );
      client.release(true);
    }
  }
}
