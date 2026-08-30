import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import { PG_POOL, TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';
import { TenantRegistryService } from './tenant-registry.service';

const MEMBERSHIP_WRITER_ROLE = 'tenant_membership_writer';

/**
 * Writes `platform.tenant_users` — the mapping from an authenticated identity
 * to the tenant it belongs to.
 *
 * This table is the other half of creating a user, and the half that is easy to
 * forget because nothing about creating one goes near it. A profile row in a
 * tenant schema says what someone may do *once their tenant is known*;
 * `TenantRegistryService.forUser` is what knows it, and this table is all it
 * reads. An account created without a row here authenticates perfectly and then
 * resolves to no tenant at all: AuthGuard finds no local profile because it has
 * nowhere to look for one, and every tRPC procedure calling `requireTenant()`
 * throws FORBIDDEN. The account exists, the password works, and the application
 * is unusable.
 *
 * ## Why this is a service rather than one more query
 *
 * `ovl_api` has SELECT on this table and nothing else (platform-bootstrap.sql
 * section 3), so the write cannot be done on the serving pool as-is. That
 * restriction is deliberate and worth keeping: an identity's tenant decides
 * which schema it reaches, so a request path that could rewrite this at will
 * could move an account onto another operator's tenant.
 *
 * The privilege therefore lives in a role of its own, assumed for exactly one
 * transaction, in the same dormant-membership pattern as `platform_publisher`,
 * `edge_registrar` and `audit_writer`. `ovl_api` is a member and NOINHERIT, so
 * the grant is inert everywhere except inside `register()`.
 *
 * ## Why it takes its own connection
 *
 * Same reason AuditService does. Callers are usually inside a tenant
 * transaction bound to `tenant_<slug>_rw`, and that role cannot write the
 * control plane; a super admin in read mode is inside a transaction pinned
 * `transaction_read_only`, where the INSERT would fail outright. Neither is a
 * reason to skip the mapping, so this runs on a connection of its own.
 *
 * The corollary is that callers must not hold a tenant transaction open across
 * a call to this — see `UsersService.createUser`, which deliberately calls it
 * after its own transaction commits. Taking a second connection while holding
 * the first is the deadlock TenantDbService's reentrancy comment describes:
 * with `maxConcurrentPerTenant` at a third of the pool, three tenants doing it
 * at once exhausts the pool with every holder waiting on a holder.
 */
@Injectable()
export class TenantMembershipService {
  private readonly logger = new Logger(TenantMembershipService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
    private readonly registry: TenantRegistryService,
  ) {}

  /**
   * Points an authenticated identity at a tenant, and invalidates the cached
   * resolution so the next request sees it.
   *
   * Idempotent, and an existing mapping is overwritten rather than left alone:
   * re-running it is how an account created before this existed gets repaired,
   * and how a genuine reassignment lands. Throws on failure — a caller that
   * swallowed this would be recreating the very bug this fixes.
   */
  async register(supertokensUserId: string, tenantId: string): Promise<void> {
    const client = await this.pool.connect();
    let bound = false;

    try {
      await this.bind(client);
      bound = true;

      await client.query(
        `INSERT INTO platform.tenant_users (supertokens_user_id, tenant_id)
         VALUES ($1, $2)
         ON CONFLICT (supertokens_user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
        [supertokensUserId, tenantId],
      );

      await client.query('COMMIT');
      client.release();
    } catch (error) {
      await this.rollbackAndRelease(client, bound);
      throw error;
    }

    // Outside the try: a failed write must not clear a cache that is still
    // correct. `forUser` caches negative lookups too, so an account that was
    // probed before it was enrolled would otherwise stay tenantless for a full
    // TTL after being created.
    this.registry.invalidate();
    this.logger.log(`Mapped identity ${supertokensUserId} to tenant ${tenantId}`);
  }

  /**
   * Same preamble as PlatformDbService and AuditService, and verified the same
   * way.
   *
   * The verification is not ceremony: `SET LOCAL ROLE` outside a transaction
   * silently does nothing, and an unbound connection here still holds
   * `ovl_api`, which has SELECT on this table — so a bind that quietly failed
   * would produce `permission denied` rather than a wrong write, but only by
   * luck of which grant happens to be missing. Proving the role is what makes
   * that a guarantee.
   */
  private async bind(client: PoolClient): Promise<void> {
    const timeout = Number(this.options.statementTimeoutMillis);
    const preamble = [
      'BEGIN',
      `SET LOCAL ROLE ${escapeIdentifier(MEMBERSHIP_WRITER_ROLE)}`,
      'SET LOCAL search_path TO platform',
      timeout > 0 ? `SET LOCAL statement_timeout = ${timeout}` : null,
      'SELECT current_user AS bound_role',
    ]
      .filter(Boolean)
      .join('; ');

    const results = (await client.query(preamble)) as unknown as Array<{
      rows: Array<{ bound_role: string }>;
    }>;
    const verification = Array.isArray(results) ? results[results.length - 1] : results;
    const observed = verification?.rows?.[0]?.bound_role;

    if (observed !== MEMBERSHIP_WRITER_ROLE) {
      throw new Error(
        `Refusing to write tenant membership: expected role ${MEMBERSHIP_WRITER_ROLE}, ` +
          `connection reports ${observed}. Re-run packages/database/bootstrap/` +
          `platform-bootstrap.sql — it is idempotent, and section 10 creates this role ` +
          `and grants it to ovl_api.`,
      );
    }
  }

  private async rollbackAndRelease(client: PoolClient, bound: boolean): Promise<void> {
    if (!bound) {
      client.release(true);
      return;
    }
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch {
      // A connection whose ROLLBACK failed is of unknown state; destroy it
      // rather than hand it back to the pool mid-transaction.
      client.release(true);
    }
  }
}
