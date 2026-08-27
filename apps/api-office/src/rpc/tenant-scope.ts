import { TenantDbService, type TenantDatabase } from '../tenancy/tenant-db.service';
import { runAsSystemForTenant } from '../tenancy/tenant-context';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import { requireCatalogue, requireTenant } from './trpc.base';
import { assertEdgeKeyValid, type EdgeTokenContext } from './edge-auth';

/**
 * Running a procedure against the caller's own tenant schema.
 *
 * Two entry points because there are two ways a caller proves who they are.
 * A session-authenticated request already has its tenant on the async context,
 * put there by TenantMiddleware. A vessel presents a bearer token and has no
 * session, so its tenant comes from the key.
 *
 * Both end in the same place — one transaction bound to one tenant — which is
 * what makes `SET LOCAL ROLE` the thing that decides what a request may reach,
 * rather than the query it happens to write.
 */

/** Session-authenticated: the tenant is already on the context. */
export function withTenantDb<T>(
  tenantDb: TenantDbService | undefined,
  fn: (db: TenantDatabase) => Promise<T>,
  options?: { readOnly?: boolean },
): Promise<T> {
  requireTenant();
  return requireCatalogue(tenantDb).withTenant(fn, options);
}

/**
 * Vessel-authenticated: resolve the tenant from the key, then authenticate and
 * do the work in one transaction.
 *
 * Verifying separately would let the two disagree — a key revoked between the
 * check and the write would still get its write committed.
 */
export async function withEdgeTenant<T>(
  deps: { edgeTenants?: EdgeTenantResolverService; tenantDb?: TenantDbService },
  ctx: EdgeTokenContext,
  fn: (db: TenantDatabase) => Promise<T>,
): Promise<T> {
  const resolver = requireCatalogue(deps.edgeTenants);
  const tenantDb = requireCatalogue(deps.tenantDb);

  const tenant = await resolver.resolve(ctx.tokenLookupHash);
  if (!tenant) {
    const { TRPCError } = await import('@trpc/server');
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or revoked API key' });
  }

  return runAsSystemForTenant({ ...tenant, requestId: 'edge' }, () =>
    tenantDb.withTenant(async (db) => {
      await assertEdgeKeyValid(tenantDb, ctx.tokenHash);
      return fn(db);
    }),
  );
}
