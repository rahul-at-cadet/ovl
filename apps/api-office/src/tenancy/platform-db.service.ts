import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { platformSchema, superAdmins, type PlatformDatabase } from '@ovl/database';
import { PG_POOL, PLATFORM_DB, TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';

/** A Drizzle handle bound to `platform_publisher` for one transaction. */
export type PublisherDatabase = ReturnType<typeof drizzle<typeof platformSchema>>;

const PUBLISHER_ROLE = 'platform_publisher';

export class NotASuperAdminError extends ForbiddenException {
  constructor() {
    super('This action requires a platform super admin.');
  }
}

/**
 * Control-plane data access, and the only way to write the master catalogue.
 *
 * The counterpart to TenantDbService, using the same mechanism for the same
 * reason. `ovl_api` is a member of `platform_publisher` but NOINHERIT, so that
 * membership is dormant: catalogue writes are possible only inside a
 * transaction that has explicitly run `SET LOCAL ROLE platform_publisher`.
 *
 * That matters because it means an ordinary tenant request cannot write the
 * catalogue *even if the application logic is wrong*. A missing authorisation
 * check would be a bug; without the role assumption it is still a
 * `permission denied` from Postgres. Reads of the catalogue need no elevation —
 * every tenant role can already SELECT it.
 */
@Injectable()
export class PlatformDbService {
  private readonly logger = new Logger(PlatformDbService.name);
  private readonly superAdminCache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PLATFORM_DB) private readonly platformDb: PlatformDatabase,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
  ) {}

  /** Unelevated control-plane reads: the registry, and the master catalogue. */
  get db(): PlatformDatabase {
    return this.platformDb;
  }

  /**
   * Is this identity a platform super admin?
   *
   * Cached briefly. A short TTL is the right trade here: promotions are rare
   * and happen out of band via the CLI, while this is consulted on every
   * catalogue request. Revocation therefore takes effect within one TTL — call
   * `invalidateSuperAdmins()` after a CLI change to make it immediate.
   */
  async isSuperAdmin(supertokensUserId: string): Promise<boolean> {
    const cached = this.superAdminCache.get(supertokensUserId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const rows = await this.platformDb
      .select({ id: superAdmins.supertokensUserId })
      .from(superAdmins)
      .where(eq(superAdmins.supertokensUserId, supertokensUserId))
      .limit(1);

    const value = rows.length > 0;
    this.superAdminCache.set(supertokensUserId, {
      value,
      expiresAt: Date.now() + this.options.registryCacheTtlMillis,
    });
    return value;
  }

  /**
   * The email recorded for a super admin, for the audit log.
   *
   * Read from `platform.super_admins` rather than from SuperTokens: an audit
   * row must stay legible after the identity it names is deleted, and this is
   * the copy that survives. Returns null for anyone who is not a super admin.
   */
  async superAdminEmail(supertokensUserId: string): Promise<string | null> {
    const rows = await this.platformDb
      .select({ email: superAdmins.email })
      .from(superAdmins)
      .where(eq(superAdmins.supertokensUserId, supertokensUserId))
      .limit(1);
    return rows[0]?.email ?? null;
  }

  invalidateSuperAdmins(): void {
    this.superAdminCache.clear();
  }

  /**
   * Runs `fn` with catalogue write privileges, after proving the caller is a
   * super admin.
   *
   * The check and the elevation are deliberately welded together in one method
   * rather than left to each call site. A call site that forgets to check is
   * the failure this design is guarding against, and the only way to reach the
   * elevated role is through here.
   */
  async asPublisher<T>(
    supertokensUserId: string,
    fn: (db: PublisherDatabase) => Promise<T>,
  ): Promise<T> {
    if (!(await this.isSuperAdmin(supertokensUserId))) {
      this.logger.warn(`Refused catalogue write for non-super-admin ${supertokensUserId}`);
      throw new NotASuperAdminError();
    }
    return this.runAsPublisher(fn);
  }

  /**
   * Elevation without an identity check, for work that has no caller: the
   * curated-catalogue seeder and CLI commands.
   *
   * Named so that a grep for catalogue writes finds it, and deliberately not
   * exported through any HTTP or tRPC path — anything reachable by a request
   * must go through `asPublisher`.
   */
  async runAsPublisher<T>(fn: (db: PublisherDatabase) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let bound = false;

    try {
      await this.bind(client);
      bound = true;

      const db = drizzle(client, { schema: platformSchema });
      const result = await fn(db as PublisherDatabase);

      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      await this.rollbackAndRelease(client, bound, error);
      throw error;
    }
  }

  /**
   * Same preamble as TenantDbService, and verified the same way: a bind that
   * silently did not apply becomes an exception here rather than a write that
   * lands with whatever privileges the connection happened to have.
   */
  private async bind(client: PoolClient): Promise<void> {
    const role = escapeIdentifier(PUBLISHER_ROLE);
    const timeout = Number(this.options.statementTimeoutMillis);

    const preamble = [
      'BEGIN',
      `SET LOCAL ROLE ${role}`,
      // Catalogue tables are schema-qualified in the Drizzle definitions, so
      // this is belt and braces — but it means an unqualified name in any
      // hand-written SQL cannot fall through to a tenant schema.
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

    if (observed !== PUBLISHER_ROLE) {
      throw new Error(
        `Refusing to write the master catalogue: expected role ${PUBLISHER_ROLE}, ` +
          `connection reports ${observed}`,
      );
    }
  }

  private async rollbackAndRelease(
    client: PoolClient,
    bound: boolean,
    cause: unknown,
  ): Promise<void> {
    if (!bound) {
      client.release(true);
      return;
    }
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      this.logger.error(
        `ROLLBACK failed on a catalogue write; destroying the connection rather than ` +
          `returning it to the pool. Original error: ${String(cause)}`,
        rollbackError instanceof Error ? rollbackError.stack : undefined,
      );
      client.release(true);
    }
  }
}
