import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import supertokens from 'supertokens-node';
import {
  AUDIT_EVENT_CLASSES,
  type AuditEventClass,
  type AuditOutcome,
} from '@ovl/database';
import { PG_POOL, TENANCY_OPTIONS, type ResolvedTenancyOptions } from '../tenancy/tenancy.constants';
import { tryCurrentTenant } from '../tenancy/tenant-context';

const WRITER_ROLE = 'audit_writer';
const READER_ROLE = 'audit_reader';

/** Which retention tier an event falls into. See platform-bootstrap.sql. */
export const AUDIT_CLASS_OF: Record<string, AuditEventClass> = {
  'auth.login': 'auth',
  'auth.logout': 'auth',
  'auth.password_changed': 'auth',

  'user.created': 'admin',
  'user.roles_changed': 'admin',
  'user.deactivated': 'admin',
  'user.deleted': 'admin',
  'user.reactivated': 'admin',
  'user.password_reset': 'admin',
  'tenant.provisioned': 'admin',
  'tenant.settings_changed': 'admin',
  'tenant.status_changed': 'admin',
  'tenant.destroyed': 'admin',
  'super_admin.granted': 'admin',
  'super_admin.revoked': 'admin',

  'impersonation.started': 'impersonation',
  'impersonation.stopped': 'impersonation',
  'impersonation.mode_changed': 'impersonation',
};

export interface AuditEventInput {
  /** Dotted name. Prefer a key of AUDIT_CLASS_OF so the class is inferred. */
  event: string;
  /** Optional when `event` is a known name; required for anything new. */
  eventClass?: AuditEventClass;
  outcome?: AuditOutcome;
  tenantId?: string | null;
  tenantSlug?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorIsSuperAdmin?: boolean;
  subject?: string | null;
  detail?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * What the request layer knows and a data service does not.
 *
 * Threaded through rather than pulled from an async context on purpose: a
 * service that reaches for the current request is a service that behaves
 * differently when called from a CLI, and provisioning is called from both.
 */
export interface AuditRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Who is doing it, for services that act on someone other than the caller.
 *
 * `UsersService.deactivateUser(id)` knows the subject and not the actor, and
 * the difference between "this account was deactivated" and "this account was
 * deactivated by that administrator" is the whole value of the row.
 */
export interface AuditActor extends AuditRequestMeta {
  userId?: string | null;
  email?: string | null;
  isSuperAdmin?: boolean;
}

export interface AuditQuery {
  /** Restrict to one tenant. A tenant admin reading their own log always sets this. */
  tenantId?: string | null;
  actorUserId?: string;
  eventClass?: AuditEventClass;
  /** Keyset pagination: return events strictly older than this timestamp. */
  before?: string;
  limit?: number;
}

/**
 * The append-only record of who did what, and in whose tenant.
 *
 * Two things about this service are load-bearing, and both are easy to undo by
 * accident.
 *
 * **It takes its own connection.** Never the caller's. A super admin viewing a
 * tenant in read mode is inside a transaction that has run
 * `SET LOCAL transaction_read_only = on`, and an INSERT on that connection
 * fails — so an audit log written inside the caller's transaction would be
 * absent from exactly the sessions it exists to record. Pigment hit this and
 * concluded that database-level read-only enforcement was unworkable; it is
 * workable, provided the audit write is on a connection of its own.
 *
 * **It never throws.** An audit failure must not turn a successful sign-in
 * into a 500. Failures are logged at error level with the event that was lost,
 * which is the compromise: the request survives, and the gap is visible in the
 * logs rather than silent. A deployment that needs fail-closed semantics
 * should alert on that log line rather than change this.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly emailCache = new Map<string, string | null>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
  ) {}

  /**
   * Records one event. Resolves whether or not the write succeeded.
   *
   * Awaiting it is safe (it cannot reject) and so is discarding it with
   * `void`. Await where the ordering matters — a destructive action whose
   * record should exist before the action does — and discard on hot paths.
   */
  async record(input: AuditEventInput): Promise<void> {
    const eventClass = input.eventClass ?? AUDIT_CLASS_OF[input.event];
    if (!eventClass || !AUDIT_EVENT_CLASSES.includes(eventClass)) {
      // Refusing the row rather than guessing a class: the class decides how
      // long the row lives, and guessing it wrong means an impersonation
      // record deleted at twelve months.
      this.logger.error(
        `Dropped audit event ${input.event}: no retention class. Add it to AUDIT_CLASS_OF ` +
          `or pass eventClass explicitly.`,
      );
      return;
    }

    // The tenant is genuinely ambient — TenantMiddleware resolves it once per
    // request and every service below reads it from the async context — so an
    // event inside a tenant request need not be told which tenant it is in.
    // An explicit value always wins; impersonation events set one before the
    // context exists.
    const inferred =
      input.tenantId === undefined && input.tenantSlug === undefined
        ? tryCurrentTenant()
        : null;
    const tenantId = input.tenantId ?? inferred?.tenantId ?? null;
    const tenantSlug = input.tenantSlug ?? inferred?.slug ?? null;

    // Filled in here rather than at each call site, because a call site that
    // forgets is a row that becomes unreadable the moment the account is
    // deleted — which is exactly the row an auditor comes looking for. The
    // identity provider answers this for a tenant user and a super admin
    // alike, and needs no tenant context to do it.
    const actorEmail =
      input.actorEmail ?? (input.actorUserId ? await this.resolveEmail(input.actorUserId) : null);

    let client: PoolClient | undefined;
    let bound = false;
    try {
      client = await this.pool.connect();
      await this.bind(client);
      bound = true;

      await client.query(
        `INSERT INTO platform.audit_events
           (tenant_id, tenant_slug, event, event_class, outcome,
            actor_user_id, actor_email, actor_is_super_admin,
            subject, detail, request_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
        [
          tenantId,
          tenantSlug,
          input.event,
          eventClass,
          input.outcome ?? 'success',
          input.actorUserId ?? null,
          actorEmail,
          input.actorIsSuperAdmin ?? false,
          input.subject ?? null,
          JSON.stringify(input.detail ?? {}),
          input.requestId ?? null,
          input.ip ?? null,
          input.userAgent ?? null,
        ],
      );

      await client.query('COMMIT');
      client.release();
    } catch (error) {
      this.logger.error(
        `Failed to record audit event ${input.event} (actor ${input.actorUserId ?? 'unknown'}, ` +
          `tenant ${tenantSlug ?? 'none'}): ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (client) await this.rollbackAndRelease(client, bound);
    }
  }

  /**
   * The email behind a SuperTokens id.
   *
   * Cached for the process lifetime: an identity's address changes about as
   * often as never, and without a cache a burst of administrative activity
   * would put one call to the identity provider on every audited action.
   * A stale entry is harmless — the row records the address at the time it
   * was written, which is what an audit trail is supposed to do.
   */
  private async resolveEmail(userId: string): Promise<string | null> {
    const cached = this.emailCache.get(userId);
    if (cached !== undefined) return cached;
    try {
      const user = await supertokens.getUser(userId);
      const email = user?.emails[0] ?? null;
      this.emailCache.set(userId, email);
      return email;
    } catch {
      // Never fatal: a row with no email is worse than one with, and far
      // better than no row at all.
      return null;
    }
  }

  /**
   * Reads the log.
   *
   * Unlike `record`, this one throws: a failed read is a failed request, and
   * showing an empty audit log that is empty because the query broke would be
   * worse than an error.
   *
   * Authorisation is the caller's job and is not optional. `tenantId` is what
   * confines a tenant admin to their own events; a caller that omits it is
   * asking for every tenant's, which only a super admin may do.
   */
  async list(query: AuditQuery = {}): Promise<AuditEventListRow[]> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.tenantId !== undefined) {
      if (query.tenantId === null) {
        conditions.push('e.tenant_id IS NULL');
      } else {
        params.push(query.tenantId);
        conditions.push(`e.tenant_id = $${params.length}`);
      }
    }
    if (query.actorUserId) {
      params.push(query.actorUserId);
      conditions.push(`e.actor_user_id = $${params.length}`);
    }
    if (query.eventClass) {
      params.push(query.eventClass);
      conditions.push(`e.event_class = $${params.length}`);
    }
    if (query.before) {
      params.push(query.before);
      conditions.push(`e.at < $${params.length}`);
    }
    params.push(limit);

    const client = await this.pool.connect();
    let bound = false;
    try {
      await this.bind(client, READER_ROLE);
      bound = true;

      const { rows } = await client.query<AuditEventListRow>(
        `SELECT e.id, e.at, e.tenant_id AS "tenantId",
                COALESCE(t.name, e.tenant_slug) AS "tenantName",
                e.tenant_slug AS "tenantSlug",
                e.event, e.event_class AS "eventClass", e.outcome,
                e.actor_user_id AS "actorUserId", e.actor_email AS "actorEmail",
                e.actor_is_super_admin AS "actorIsSuperAdmin",
                e.subject, e.detail, e.ip, e.user_agent AS "userAgent"
           FROM platform.audit_events e
           LEFT JOIN platform.tenants t ON t.id = e.tenant_id
          ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY e.at DESC
          LIMIT $${params.length}`,
        params,
      );

      await client.query('COMMIT');
      client.release();
      return rows;
    } catch (error) {
      await this.rollbackAndRelease(client, bound);
      throw error;
    }
  }

  /**
   * Same preamble as PlatformDbService, and verified the same way.
   *
   * The verification is not ceremony: `SET LOCAL ROLE` outside a transaction
   * silently does nothing, and a write that landed as `ovl_api` instead of
   * `audit_writer` would fail on grants — but a *read* that landed as the
   * wrong role could quietly succeed with privileges nobody intended.
   */
  private async bind(client: PoolClient, role: string = WRITER_ROLE): Promise<void> {
    const timeout = Number(this.options.statementTimeoutMillis);
    const preamble = [
      'BEGIN',
      `SET LOCAL ROLE ${escapeIdentifier(role)}`,
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

    if (observed !== role) {
      throw new Error(
        `Refusing to touch the audit log: expected role ${role}, connection reports ${observed}`,
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

export interface AuditEventListRow {
  id: string;
  at: string;
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  event: string;
  eventClass: AuditEventClass;
  outcome: AuditOutcome;
  actorUserId: string | null;
  actorEmail: string | null;
  actorIsSuperAdmin: boolean;
  subject: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}
