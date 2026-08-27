import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import { and, eq, isNull } from 'drizzle-orm';
import { edgeCredentials, type PlatformDatabase } from '@ovl/database';
import { PG_POOL, PLATFORM_DB, TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';
import { TenantRegistryService, type TenantDescriptor } from './tenant-registry.service';

const REGISTRAR_ROLE = 'edge_registrar';

/**
 * Resolves a vessel's API key to the tenant that issued it.
 *
 * Session-authenticated requests get their tenant from the SuperTokens user id
 * (see TenantMiddleware). Vessels have no session — they present a bearer
 * token — and the `api_keys` table that would identify them lives inside a
 * tenant schema, which cannot be read without already knowing the tenant.
 * `platform.edge_credentials` breaks that circle.
 *
 * The index deliberately stores only the *lookup* hash, which is derived from
 * the first characters of the token. It is a pointer, not a credential:
 * resolving a tenant from it proves nothing, and the caller must still verify
 * the full token hash against the `api_keys` row inside that tenant's schema.
 * Getting this backwards — treating a lookup-hash match as authentication —
 * would make a 32-bit prefix collision an authentication bypass.
 */
@Injectable()
export class EdgeTenantResolverService {
  private readonly logger = new Logger(EdgeTenantResolverService.name);
  private readonly cache = new Map<string, { descriptor: TenantDescriptor | null; expiresAt: number }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PLATFORM_DB) private readonly platformDb: PlatformDatabase,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
    private readonly registry: TenantRegistryService,
  ) {}

  /**
   * The tenant that issued this key, or null.
   *
   * Null covers an unknown key, a revoked one, and a key whose tenant is no
   * longer active — all of which must look identical to the caller, since
   * distinguishing them would tell an unauthenticated caller which key prefixes
   * exist.
   */
  async resolve(tokenLookupHash: string): Promise<TenantDescriptor | null> {
    const cached = this.cache.get(tokenLookupHash);
    if (cached && cached.expiresAt > Date.now()) return cached.descriptor;

    const rows = await this.platformDb
      .select({ tenantId: edgeCredentials.tenantId })
      .from(edgeCredentials)
      .where(
        and(
          eq(edgeCredentials.tokenLookupHash, tokenLookupHash),
          isNull(edgeCredentials.revokedAt),
        ),
      )
      .limit(1);

    const descriptor = rows[0] ? await this.registry.byId(rows[0].tenantId) : null;

    this.cache.set(tokenLookupHash, {
      descriptor,
      expiresAt: Date.now() + this.options.registryCacheTtlMillis,
    });
    return descriptor;
  }

  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Records which tenant a newly minted key belongs to.
   *
   * Runs as `edge_registrar`, assumed for this transaction only. A tenant role
   * must not be able to write here: one that could would be able to point
   * another tenant's key at itself, which is a cross-tenant read dressed up as
   * a registration.
   *
   * Callers pass the tenant explicitly rather than reading it from the ambient
   * context, so that provisioning and backfill — neither of which has a
   * request behind it — use the same path as key creation.
   */
  async register(
    tokenLookupHash: string,
    tenantId: string,
    label?: string,
  ): Promise<void> {
    await this.asRegistrar(async (client) => {
      await client.query(
        `INSERT INTO platform.edge_credentials (token_lookup_hash, tenant_id, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_lookup_hash)
         DO UPDATE SET tenant_id = EXCLUDED.tenant_id, label = EXCLUDED.label, revoked_at = NULL`,
        [tokenLookupHash, tenantId, label ?? null],
      );
    });
    this.invalidate();
  }

  /**
   * Marks a key as revoked in the index.
   *
   * Kept as a row rather than deleted so the index still explains a key that
   * turns up later, and so revocation is auditable. The tenant-side `api_keys`
   * row is the authority on whether a key works; this only stops it resolving
   * a tenant at all.
   */
  async revoke(tokenLookupHash: string): Promise<void> {
    await this.asRegistrar(async (client) => {
      await client.query(
        `UPDATE platform.edge_credentials SET revoked_at = now() WHERE token_lookup_hash = $1`,
        [tokenLookupHash],
      );
    });
    this.invalidate();
  }

  /**
   * Assumes `edge_registrar` for one transaction, and proves it took.
   *
   * Same shape as TenantDbService and PlatformDbService: a bind that silently
   * failed to apply becomes an exception here rather than a write attempted
   * with whatever privileges the connection happened to have.
   */
  private async asRegistrar(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    let bound = false;

    try {
      const role = escapeIdentifier(REGISTRAR_ROLE);
      const results = (await client.query(
        `BEGIN; SET LOCAL ROLE ${role}; SET LOCAL search_path TO platform; ` +
          `SELECT current_user AS bound_role`,
      )) as unknown as Array<{ rows: Array<{ bound_role: string }> }>;

      const verification = Array.isArray(results) ? results[results.length - 1] : results;
      const observed = verification?.rows?.[0]?.bound_role;
      if (observed !== REGISTRAR_ROLE) {
        throw new Error(
          `Refusing to write edge credentials: expected role ${REGISTRAR_ROLE}, ` +
            `connection reports ${observed}`,
        );
      }
      bound = true;

      await fn(client);
      await client.query('COMMIT');
      client.release();
    } catch (error) {
      if (!bound) {
        client.release(true);
      } else {
        try {
          await client.query('ROLLBACK');
          client.release();
        } catch (rollbackError) {
          this.logger.error(
            `ROLLBACK failed registering an edge credential; destroying the connection. ` +
              `Original error: ${String(error)}`,
            rollbackError instanceof Error ? rollbackError.stack : undefined,
          );
          client.release(true);
        }
      }
      throw error;
    }
  }
}
