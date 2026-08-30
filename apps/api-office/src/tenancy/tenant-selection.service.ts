import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ADMIN_PG_POOL } from './tenancy.constants';
import { TenantRegistryService } from './tenant-registry.service';
import { PlatformDbService } from './platform-db.service';

/** Thrown when the admin pool is not configured, so selection cannot be written. */
export class SelectionDisabledError extends Error {
  constructor() {
    super(
      'Tenant selection requires ADMIN_DATABASE_URL — the role that owns the platform registry.',
    );
    this.name = 'SelectionDisabledError';
  }
}

/**
 * Which tenant a platform super admin is currently viewing.
 *
 * A super admin belongs to no tenant but can look into any of them, so
 * "which tenant am I acting as?" is a real piece of per-user state. It is kept
 * server-side, against their SuperTokens identity, rather than travelling with
 * the request: TenantMiddleware resolves a tenant from the session and from
 * nothing the caller sends, because a caller who can name its own tenant has
 * turned authentication into a formality. That guarantee has to keep holding
 * for everyone, so a super admin's legitimate choice is authorised here and
 * then stored, and the middleware still reads it from the session's identity.
 *
 * Written through the administrative pool because `ovl_api` deliberately has
 * only SELECT on the platform registry — the same asymmetry that stops a
 * compromised request path promoting a super admin stops it choosing one's
 * tenant.
 */
@Injectable()
export class TenantSelectionService {
  private readonly logger = new Logger(TenantSelectionService.name);

  constructor(
    @Optional() @Inject(ADMIN_PG_POOL) private readonly adminPool: Pool | null,
    private readonly registry: TenantRegistryService,
    private readonly platform: PlatformDbService,
  ) {}

  get enabled(): boolean {
    return this.adminPool !== null;
  }

  /** The tenant this super admin is currently viewing, or null. */
  async current(supertokensUserId: string): Promise<{ slug: string; name: string } | null> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ slug: string; name: string }>(
      `SELECT t.slug, t.name
         FROM platform.super_admin_tenant_selection s
         JOIN platform.tenants t ON t.id = s.tenant_id
        WHERE s.supertokens_user_id = $1`,
      [supertokensUserId],
    );
    return rows[0] ?? null;
  }

  /**
   * Points a super admin at one tenant.
   *
   * Re-checks super admin membership here rather than trusting the caller to
   * have done it: this writes the row that decides which schema every
   * subsequent request of theirs reads, so it is the last place the check can
   * still matter.
   */
  async select(supertokensUserId: string, slug: string): Promise<{ slug: string }> {
    const pool = this.requirePool();

    if (!(await this.platform.isSuperAdmin(supertokensUserId))) {
      throw new Error('Only a platform super admin may select a tenant to view.');
    }

    const tenant = await this.registry.forSlug(slug);
    if (!tenant) throw new Error(`No tenant with slug ${slug}.`);

    await pool.query(
      `INSERT INTO platform.super_admin_tenant_selection (supertokens_user_id, tenant_id)
       VALUES ($1, $2)
       ON CONFLICT (supertokens_user_id)
       DO UPDATE SET tenant_id = EXCLUDED.tenant_id, selected_at = now()`,
      [supertokensUserId, tenant.tenantId],
    );

    // The registry caches user→tenant lookups; without this the super admin
    // keeps seeing the previous tenant until the TTL expires.
    this.registry.invalidate();
    this.logger.log(`Super admin ${supertokensUserId} is now viewing tenant ${slug}`);
    return { slug };
  }

  /** Returns the super admin to having no tenant in view. */
  async clear(supertokensUserId: string): Promise<void> {
    const pool = this.requirePool();
    await pool.query(
      `DELETE FROM platform.super_admin_tenant_selection WHERE supertokens_user_id = $1`,
      [supertokensUserId],
    );
    this.registry.invalidate();
  }

  private requirePool(): Pool {
    if (!this.adminPool) throw new SelectionDisabledError();
    return this.adminPool;
  }
}
