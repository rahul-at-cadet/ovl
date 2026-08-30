import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ADMIN_PG_POOL } from './tenancy.constants';
import { TenantRegistryService } from './tenant-registry.service';
import { PlatformDbService } from './platform-db.service';
import { AuditService, type AuditRequestMeta } from '../audit/audit.service';

/** What a super admin is currently looking at, and what they may do there. */
export interface TenantView {
  slug: string;
  name: string;
  mode: 'read' | 'write';
  /** When write mode lapses back to read. Null in read mode. */
  writeExpiresAt: string | null;
}

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

  /**
   * How long write mode lasts before lapsing back to read.
   *
   * Write access that persists until someone remembers to turn it off is write
   * access that is always on. Thirty minutes is the common industry setting
   * for impersonation sessions and is long enough for a real support task.
   */
  static readonly WRITE_MODE_TTL_MS = 30 * 60 * 1000;

  constructor(
    @Optional() @Inject(ADMIN_PG_POOL) private readonly adminPool: Pool | null,
    private readonly registry: TenantRegistryService,
    private readonly platform: PlatformDbService,
    private readonly audit: AuditService,
  ) {}

  get enabled(): boolean {
    return this.adminPool !== null;
  }

  /**
   * The tenant this super admin is viewing, and in which mode.
   *
   * Expiry is applied in the query rather than by a sweeper: a lapsed write
   * window must read as 'read' the instant it passes, and a background job
   * would leave a gap in which it still read as 'write'.
   */
  async current(supertokensUserId: string): Promise<TenantView | null> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{
      slug: string;
      name: string;
      mode: 'read' | 'write';
      write_expires_at: string | null;
    }>(
      `SELECT t.slug,
              t.name,
              CASE
                WHEN s.mode = 'write' AND s.write_expires_at > now() THEN 'write'
                ELSE 'read'
              END AS mode,
              s.write_expires_at
         FROM platform.super_admin_tenant_selection s
         JOIN platform.tenants t ON t.id = s.tenant_id
        WHERE s.supertokens_user_id = $1`,
      [supertokensUserId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      slug: row.slug,
      name: row.name,
      mode: row.mode,
      writeExpiresAt: row.mode === 'write' ? row.write_expires_at : null,
    };
  }

  /** Switches the mode for the tenant already in view. */
  async setMode(
    supertokensUserId: string,
    mode: 'read' | 'write',
    meta: AuditRequestMeta = {},
  ): Promise<TenantView | null> {
    const pool = this.requirePool();
    const before = await this.current(supertokensUserId);

    if (!(await this.platform.isSuperAdmin(supertokensUserId))) {
      await this.audit.record({
        event: 'impersonation.mode_changed',
        outcome: 'failure',
        actorUserId: supertokensUserId,
        detail: { requestedMode: mode, reason: 'not a super admin' },
        ...meta,
      });
      throw new Error('Only a platform super admin may change access mode.');
    }

    await pool.query(
      `UPDATE platform.super_admin_tenant_selection
          SET mode = $2,
              write_expires_at = CASE WHEN $2 = 'write' THEN now() + ($3::int * interval '1 millisecond') ELSE NULL END
        WHERE supertokens_user_id = $1`,
      [supertokensUserId, mode, TenantSelectionService.WRITE_MODE_TTL_MS],
    );

    this.registry.invalidate();
    this.logger.warn(`Super admin ${supertokensUserId} switched to ${mode} mode`);

    const after = await this.current(supertokensUserId);
    // The single most important row in the log: write mode is unrestricted
    // inside the tenant, so the record that it was entered — by whom, in
    // whose tenant, and until when — is the whole control on it.
    await this.audit.record({
      event: 'impersonation.mode_changed',
      actorUserId: supertokensUserId,
      actorEmail: await this.platform.superAdminEmail(supertokensUserId),
      actorIsSuperAdmin: true,
      tenantSlug: after?.slug ?? before?.slug ?? null,
      tenantId: await this.tenantIdForSlug(after?.slug ?? before?.slug),
      subject: after?.slug ?? before?.slug ?? null,
      detail: {
        from: before?.mode ?? 'read',
        to: after?.mode ?? mode,
        writeExpiresAt: after?.writeExpiresAt ?? null,
      },
      ...meta,
    });
    return after;
  }

  /**
   * Points a super admin at one tenant.
   *
   * Re-checks super admin membership here rather than trusting the caller to
   * have done it: this writes the row that decides which schema every
   * subsequent request of theirs reads, so it is the last place the check can
   * still matter.
   */
  async select(
    supertokensUserId: string,
    slug: string,
    meta: AuditRequestMeta = {},
  ): Promise<{ slug: string }> {
    const pool = this.requirePool();
    const previous = await this.current(supertokensUserId);

    if (!(await this.platform.isSuperAdmin(supertokensUserId))) {
      // A non-super-admin reaching this far is the event worth keeping, so it
      // is recorded before the throw rather than only appearing as a 403 in
      // an access log that ages out in days.
      await this.audit.record({
        event: 'impersonation.started',
        outcome: 'failure',
        actorUserId: supertokensUserId,
        tenantSlug: slug,
        subject: slug,
        detail: { reason: 'not a super admin' },
        ...meta,
      });
      throw new Error('Only a platform super admin may select a tenant to view.');
    }

    const tenant = await this.registry.forSlug(slug);
    if (!tenant) throw new Error(`No tenant with slug ${slug}.`);

    await pool.query(
      // Always lands in read mode. Carrying write across a tenant switch
      // would mean arriving inside a different customer's data already able
      // to change it, which is never what the operator meant.
      `INSERT INTO platform.super_admin_tenant_selection (supertokens_user_id, tenant_id, mode, write_expires_at)
       VALUES ($1, $2, 'read', NULL)
       ON CONFLICT (supertokens_user_id)
       DO UPDATE SET tenant_id = EXCLUDED.tenant_id, selected_at = now(),
                     mode = 'read', write_expires_at = NULL`,
      [supertokensUserId, tenant.tenantId],
    );

    // The registry caches user→tenant lookups; without this the super admin
    // keeps seeing the previous tenant until the TTL expires.
    this.registry.invalidate();
    this.logger.log(`Super admin ${supertokensUserId} is now viewing tenant ${slug}`);

    await this.audit.record({
      event: 'impersonation.started',
      actorUserId: supertokensUserId,
      actorEmail: await this.platform.superAdminEmail(supertokensUserId),
      actorIsSuperAdmin: true,
      tenantId: tenant.tenantId,
      tenantSlug: slug,
      subject: slug,
      // Recorded because switching tenants is also an exit from the previous
      // one, and a log that shows only entries leaves the operator apparently
      // inside two tenants at once.
      detail: { previousTenant: previous?.slug ?? null, mode: 'read' },
      ...meta,
    });
    return { slug };
  }

  /** Returns the super admin to having no tenant in view. */
  async clear(supertokensUserId: string, meta: AuditRequestMeta = {}): Promise<void> {
    const pool = this.requirePool();
    // Read before the delete: afterwards there is nothing left to say which
    // tenant the operator was in, which is the one fact the row needs.
    const previous = await this.current(supertokensUserId);

    await pool.query(
      `DELETE FROM platform.super_admin_tenant_selection WHERE supertokens_user_id = $1`,
      [supertokensUserId],
    );
    this.registry.invalidate();

    await this.audit.record({
      event: 'impersonation.stopped',
      actorUserId: supertokensUserId,
      actorEmail: await this.platform.superAdminEmail(supertokensUserId),
      actorIsSuperAdmin: true,
      tenantId: await this.tenantIdForSlug(previous?.slug),
      tenantSlug: previous?.slug ?? null,
      subject: previous?.slug ?? null,
      detail: { modeAtExit: previous?.mode ?? null },
      ...meta,
    });
  }

  /** Slug to tenant id, for audit rows. Null when there was no tenant in view. */
  private async tenantIdForSlug(slug: string | undefined | null): Promise<string | null> {
    if (!slug) return null;
    const tenant = await this.registry.forSlug(slug);
    return tenant?.tenantId ?? null;
  }

  private requirePool(): Pool {
    if (!this.adminPool) throw new SelectionDisabledError();
    return this.adminPool;
  }
}
