import { Injectable, Logger } from '@nestjs/common';
import { TenantDbService, type TenantDatabase } from './tenant-db.service';
import { TenantRegistryService } from './tenant-registry.service';

/** Which tenant a row came from, added to every aggregated result. */
export interface TenantStamp {
  tenantSlug: string;
  tenantName: string;
}

/**
 * How many tenants are read at once.
 *
 * Each one holds a pool connection for the length of its query, so this is a
 * ceiling on how much of the pool a single platform-wide screen can occupy.
 * Four leaves most of a 15-connection pool free for ordinary tenant traffic
 * while still turning a dozen sequential round trips into three.
 */
const CONCURRENCY = 4;

/**
 * Reads the same query from every tenant, for a platform super admin.
 *
 * ## Why this is a loop and not one query
 *
 * The obvious implementation is a single `UNION ALL` across every tenant
 * schema, and it is deliberately not what this does. No role in this system
 * may read two tenants in one transaction: `ovl_api` is NOINHERIT and owns
 * nothing, and it reaches a tenant's tables only after `SET LOCAL ROLE
 * tenant_<slug>_rw` for that one tenant. A cross-schema UNION would need a
 * role holding SELECT on every tenant at once — exactly the thing layer 4 of
 * the isolation model exists to make impossible, and creating one would
 * quietly retire that guarantee for the whole application, not just for this
 * screen.
 *
 * So each tenant is read in its own bound transaction, exactly as an ordinary
 * request would, and the rows are merged here. That is N queries for N
 * tenants, which is a real cost and an honest one: the alternative is not a
 * faster query, it is a weaker boundary.
 *
 * If tenant counts ever make this too slow, the answer is a rollup written by
 * a background job or a reporting replica — not widening what `ovl_api` can
 * reach.
 *
 * ## Read-only by construction
 *
 * Every transaction is opened read-only. A platform-wide screen has no single
 * tenant to write to, and a mutation that fanned out across customers is never
 * something this class should be able to express.
 */
@Injectable()
export class PlatformFleetService {
  private readonly logger = new Logger(PlatformFleetService.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly tenantDb: TenantDbService,
  ) {}

  /**
   * Runs `read` against every active tenant and returns the rows together,
   * each stamped with the tenant it came from.
   *
   * A tenant that fails is logged and skipped rather than taking the whole
   * screen down with it: one customer's broken schema should not blank the
   * platform view of every other customer.
   */
  async acrossTenants<T>(
    read: (db: TenantDatabase) => Promise<T[]>,
  ): Promise<Array<T & TenantStamp>> {
    const tenants = (await this.registry.list()).filter((t) => t.status === 'active');
    const out: Array<T & TenantStamp> = [];

    for (let i = 0; i < tenants.length; i += CONCURRENCY) {
      const batch = tenants.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (tenant) => {
          try {
            const rows = await this.tenantDb.runFor(tenant, read, { readOnly: true });
            return rows.map((row) => ({ ...row, tenantSlug: tenant.slug, tenantName: tenant.name }));
          } catch (error) {
            this.logger.error(
              `Skipping tenant ${tenant.slug} in a platform-wide read: ${String(error)}`,
            );
            return [];
          }
        }),
      );
      for (const rows of results) out.push(...rows);
    }

    return out;
  }

  /** How many active tenants a platform-wide view is currently spanning. */
  async activeTenantCount(): Promise<number> {
    return (await this.registry.list()).filter((t) => t.status === 'active').length;
  }
}
