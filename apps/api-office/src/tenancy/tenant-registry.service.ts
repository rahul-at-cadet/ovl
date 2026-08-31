import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  tenants,
  tenantUsers,
  superAdmins,
  superAdminTenantSelection,
  type PlatformDatabase,
  type TenantStatus,
} from '@ovl/database';
import { PLATFORM_DB, TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';
import {
  assertValidTenantRoleName,
  assertValidTenantSchemaName,
} from './tenant-identifiers';
import type { TenantContext } from './tenant-context';

/** A resolved tenant, minus the per-request fields TenantContext adds. */
export type TenantDescriptor = Omit<TenantContext, 'requestId'>;

interface CacheEntry {
  descriptor: TenantDescriptor;
  expiresAt: number;
}

/**
 * Resolves identities and slugs to tenants, and is the only place that reads
 * the control-plane registry.
 *
 * The Drizzle handle injected here is typed against the platform schema alone,
 * so this service physically cannot name a tenant table. Tenant data is
 * reachable only through TenantDbService.
 *
 * Note the cache holds *descriptors* — id, slug, schema, role — which are
 * control-plane facts, not tenant business data. That is why a plain map is
 * safe here and would not be safe in a domain service; anything caching tenant
 * rows must go through TenantCacheService instead.
 */
@Injectable()
export class TenantRegistryService {
  private readonly logger = new Logger(TenantRegistryService.name);
  private readonly byUserId = new Map<string, CacheEntry>();
  private readonly bySlugCache = new Map<string, CacheEntry>();
  private readonly byIdCache = new Map<string, CacheEntry>();
  private readonly nameById = new Map<string, { name: string; expiresAt: number }>();

  constructor(
    @Inject(PLATFORM_DB) private readonly platformDb: PlatformDatabase,
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
  ) {}

  /**
   * The tenant for an authenticated identity, or null.
   *
   * This is the only supported way a request acquires a tenant. It is
   * deliberately keyed on the SuperTokens user id and nothing the caller can
   * influence — no header, no body field, no query parameter.
   */
  async forUser(supertokensUserId: string): Promise<TenantDescriptor | null> {
    const cached = this.readCache(this.byUserId, supertokensUserId);
    if (cached) return cached;

    const rows = await this.platformDb
      .select({
        id: tenants.id,
        slug: tenants.slug,
        schemaName: tenants.schemaName,
        roleName: tenants.roleName,
        status: tenants.status,
      })
      .from(tenantUsers)
      .innerJoin(tenants, eq(tenantUsers.tenantId, tenants.id))
      .where(eq(tenantUsers.supertokensUserId, supertokensUserId))
      .limit(1);

    if (rows[0]) {
      const descriptor = this.toDescriptor(rows[0]);
      if (descriptor) this.writeCache(this.byUserId, supertokensUserId, descriptor);
      return descriptor;
    }

    // No membership of their own. A platform super admin is the one identity
    // for which that is normal rather than an error: they sit above every
    // tenant and view whichever one they have selected.
    //
    // Read here rather than accepted from the request for the reason this
    // method's own comment gives — the tenant must come from the session and
    // nothing the caller can influence. A super admin nominating a tenant is
    // legitimate, but the nomination is stored server-side, and the join to
    // super_admins below means a revoked super admin's stale selection stops
    // resolving immediately.
    const selected = await this.platformDb
      .select({
        id: tenants.id,
        slug: tenants.slug,
        schemaName: tenants.schemaName,
        roleName: tenants.roleName,
        status: tenants.status,
        mode: superAdminTenantSelection.mode,
        writeExpiresAt: superAdminTenantSelection.writeExpiresAt,
      })
      .from(superAdminTenantSelection)
      .innerJoin(
        superAdmins,
        eq(superAdminTenantSelection.supertokensUserId, superAdmins.supertokensUserId),
      )
      .innerJoin(tenants, eq(superAdminTenantSelection.tenantId, tenants.id))
      .where(eq(superAdminTenantSelection.supertokensUserId, supertokensUserId))
      .limit(1);

    const row = selected[0];
    const descriptor = this.toDescriptor(row);
    if (!descriptor) return null;

    // Read mode pins the whole request read-only. Expiry is evaluated here
    // rather than trusted from the stored mode, so a lapsed write window stops
    // granting writes the moment it passes rather than at the next write.
    const writing =
      row.mode === 'write' && !!row.writeExpiresAt && new Date(row.writeExpiresAt) > new Date();

    // Deliberately not cached: a super admin switching tenant or mode must take
    // effect on the next request, not after a TTL, or they spend the cache
    // window looking at the tenant they just navigated away from — or, worse,
    // still writing after dropping back to read.
    return { ...descriptor, readOnly: !writing };
  }

  /** Lookup by slug. For the provisioning CLI and for cross-checking a subdomain. */
  async forSlug(slug: string): Promise<TenantDescriptor | null> {
    const cached = this.readCache(this.bySlugCache, slug);
    if (cached) return cached;

    const rows = await this.platformDb
      .select({
        id: tenants.id,
        slug: tenants.slug,
        schemaName: tenants.schemaName,
        roleName: tenants.roleName,
        status: tenants.status,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);

    const descriptor = this.toDescriptor(rows[0]);
    if (descriptor) this.writeCache(this.bySlugCache, slug, descriptor);
    return descriptor;
  }

  /**
   * Lookup by tenant id. For paths that already hold an id rather than an
   * identity — edge credential resolution, background jobs, admin tooling.
   */
  async byId(tenantId: string): Promise<TenantDescriptor | null> {
    const cached = this.readCache(this.byIdCache, tenantId);
    if (cached) return cached;

    const rows = await this.platformDb
      .select({
        id: tenants.id,
        slug: tenants.slug,
        schemaName: tenants.schemaName,
        roleName: tenants.roleName,
        status: tenants.status,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const descriptor = this.toDescriptor(rows[0]);
    if (descriptor) this.writeCache(this.byIdCache, tenantId, descriptor);
    return descriptor;
  }

  /** Every tenant, whatever its status. For the migration runner and admin tooling. */
  async list(): Promise<Array<TenantDescriptor & { status: TenantStatus; name: string }>> {
    const rows = await this.platformDb.select().from(tenants).orderBy(tenants.slug);
    return rows.map((row) => ({
      tenantId: row.id,
      slug: row.slug,
      schemaName: row.schemaName,
      roleName: row.roleName,
      status: row.status as TenantStatus,
      // Listed alongside the descriptor rather than added to TenantDescriptor
      // itself: that type is what gets bound into SQL, and the display name is
      // explicitly never used to build a statement.
      name: row.name,
    }));
  }

  /**
   * The tenant's display name — the customer's own company name.
   *
   * Deliberately not on TenantDescriptor and not returned by the lookups
   * above. That type is what gets bound into SQL, and the display name is the
   * one field here a customer chooses freely; keeping it out means it can
   * never reach a statement, however a descriptor is later used. This is the
   * accessor for showing it to a person, which is all it is for.
   *
   * Cached on the same TTL as the descriptors, because the office shell asks
   * for it on every page load and a rename is about as frequent as never.
   */
  async displayName(tenantId: string): Promise<string | null> {
    const cached = this.nameById.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;

    const rows = await this.platformDb
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const name = rows[0]?.name ?? null;
    if (name !== null) {
      this.nameById.set(tenantId, {
        name,
        expiresAt: Date.now() + this.options.registryCacheTtlMillis,
      });
    }
    return name;
  }

  /**
   * Drops cached lookups. Call after provisioning, suspending, or reassigning
   * a user — otherwise a suspended tenant keeps serving for up to one TTL.
   */
  invalidate(): void {
    this.byUserId.clear();
    this.bySlugCache.clear();
    this.byIdCache.clear();
    this.nameById.clear();
  }

  /**
   * Turns a registry row into something safe to put in a tenant context.
   *
   * Two checks that look redundant and are not. Status: only `active` tenants
   * resolve, so a half-provisioned schema — created but not yet migrated —
   * can never be served. Identifier shape: the row is re-validated on every
   * cache miss rather than trusted because it came from our own database. A
   * registry row could have been written by an older build, restored from a
   * backup, or edited by hand, and it is one step away from becoming SQL.
   */
  private toDescriptor(row: {
    id: string;
    slug: string;
    schemaName: string;
    roleName: string;
    status: string;
  } | undefined): TenantDescriptor | null {
    if (!row) return null;

    if (row.status !== 'active') {
      this.logger.warn(`Refusing tenant ${row.slug}: status is ${row.status}`);
      return null;
    }

    assertValidTenantSchemaName(row.schemaName);
    assertValidTenantRoleName(row.roleName);

    return {
      tenantId: row.id,
      slug: row.slug,
      schemaName: row.schemaName,
      roleName: row.roleName,
    };
  }

  private readCache(cache: Map<string, CacheEntry>, key: string): TenantDescriptor | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.descriptor;
  }

  private writeCache(
    cache: Map<string, CacheEntry>,
    key: string,
    descriptor: TenantDescriptor,
  ): void {
    cache.set(key, {
      descriptor,
      expiresAt: Date.now() + this.options.registryCacheTtlMillis,
    });
  }
}
