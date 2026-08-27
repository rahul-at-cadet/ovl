import { TRPCError } from '@trpc/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { runAsSystemForTenant } from '../tenancy/tenant-context';

/** The hashes `isEdgeAuthed` derives from a vessel's bearer token. */
export interface EdgeTokenContext {
  tokenLookupHash: string;
  tokenHash: string;
}

/**
 * What edge authentication needs, resolved lazily.
 *
 * The tenancy services are optional because the catalogue and tenant stack are
 * only registered when multi-tenancy is enabled, and edge traffic still has to
 * authenticate either way.
 */
export interface EdgeAuthDeps {
  db: NodePgDatabase<typeof schema>;
  edgeTenants?: EdgeTenantResolverService;
  tenantDb?: TenantDbService;
}

const unauthorized = () =>
  new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or revoked API key' });

/**
 * Proves the caller holds the whole API key, inside the tenant its lookup hash
 * pointed at.
 *
 * Deliberately separate from tenant resolution. Resolution says *where* to
 * look; this says *whether the caller is who they claim*. Collapsing the two
 * would make the platform index — which stores a truncated hash and is not a
 * secret — into the thing that grants access, and turn a prefix collision into
 * an authentication bypass.
 *
 * Must be called inside a tenant context.
 */
export async function assertEdgeKeyValid(
  tenantDb: TenantDbService,
  tokenHash: string,
): Promise<void> {
  const valid = await tenantDb.withTenant(
    async (db) => {
      const rows = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.tokenHash, tokenHash))
        .limit(1);
      return rows.length > 0 && !rows[0].revokedAt;
    },
    { readOnly: true },
  );

  if (!valid) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unknown API key' });
}

/**
 * Authenticates an edge (vessel) caller. Every edge procedure must call this.
 *
 * The `isEdgeAuthed` middleware only parses the bearer token and derives its
 * hashes — it never checks them against anything, as its own comment admitted
 * ("we will pass the db to the middleware inside the router class"). That was
 * only ever done inside `enroll`, so `pushEvents` and `pullConfig` accepted any
 * string beginning with `ovl_prod_`: an unauthenticated caller could push
 * report versions for any vessel id and read back that vessel's config, chat
 * and remarks. A contract test caught it.
 *
 * Verification happens where the keys actually live. With tenancy enabled that
 * is the tenant's own schema, reached through the platform pointer — the lookup
 * hash selects a schema, the full token hash authenticates. Without tenancy it
 * falls back to the shared table, so a single-tenant deployment gets the same
 * check rather than staying on the unverified path.
 */
export async function authenticateEdge(
  deps: EdgeAuthDeps,
  ctx: EdgeTokenContext,
): Promise<void> {
  if (deps.edgeTenants && deps.tenantDb) {
    const tenant = await deps.edgeTenants.resolve(ctx.tokenLookupHash);
    if (!tenant) throw unauthorized();

    const tenantDb = deps.tenantDb;
    await runAsSystemForTenant({ ...tenant, requestId: 'edge-auth' }, () =>
      assertEdgeKeyValid(tenantDb, ctx.tokenHash),
    );
    return;
  }

  const keys = await deps.db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.tokenLookupHash, ctx.tokenLookupHash));

  if (keys.length === 0 || keys[0].tokenHash !== ctx.tokenHash || keys[0].revokedAt) {
    throw unauthorized();
  }
}
