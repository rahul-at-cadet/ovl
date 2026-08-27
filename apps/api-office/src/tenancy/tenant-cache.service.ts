import { Injectable } from '@nestjs/common';
import { currentTenant } from './tenant-context';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * An in-process cache whose keys are always tenant-scoped.
 *
 * Caching is the leak path that survives every database-level defence. The
 * connection binding in TenantDbService guarantees a *query* cannot cross
 * tenants; it says nothing about a result that was cached under a bare key
 * like `vessels:all` and then served to whoever asks next. That kind of bug
 * reads perfectly well in review and only misbehaves once two tenants are
 * active at the same time.
 *
 * So the tenant id is prepended here, in one place, rather than left to each
 * call site to remember. The rule for the codebase is simply: no ad-hoc Maps
 * holding tenant data. If something needs caching, it comes through here.
 *
 * The same reasoning applies to any shared store added later — Redis keys must
 * carry the tenant id, and a per-tenant Redis prefix is the natural extension
 * point for this class.
 */
@Injectable()
export class TenantCacheService {
  private readonly entries = new Map<string, Entry>();

  /** Returns the cached value, or computes, stores and returns it. */
  async wrap<T>(namespace: string, key: string, ttlMillis: number, load: () => Promise<T>): Promise<T> {
    const scoped = this.scopedKey(namespace, key);
    const hit = this.entries.get(scoped);

    if (hit && hit.expiresAt > Date.now()) {
      return hit.value as T;
    }

    const value = await load();
    this.entries.set(scoped, { value, expiresAt: Date.now() + ttlMillis });
    return value;
  }

  get<T>(namespace: string, key: string): T | undefined {
    const hit = this.entries.get(this.scopedKey(namespace, key));
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(this.scopedKey(namespace, key));
      return undefined;
    }
    return hit.value as T;
  }

  set(namespace: string, key: string, value: unknown, ttlMillis: number): void {
    this.entries.set(this.scopedKey(namespace, key), {
      value,
      expiresAt: Date.now() + ttlMillis,
    });
  }

  delete(namespace: string, key: string): void {
    this.entries.delete(this.scopedKey(namespace, key));
  }

  /** Drops everything for the current tenant — e.g. after a config publish. */
  invalidateTenant(): void {
    const prefix = `${currentTenant().tenantId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Evicts expired entries. Wire to a cron if the working set is large. */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * `currentTenant()` throws when there is no tenant, so an attempt to cache
   * outside a tenant context fails loudly instead of writing an unscoped key
   * that the next tenant would read.
   */
  private scopedKey(namespace: string, key: string): string {
    return `${currentTenant().tenantId}:${namespace}:${key}`;
  }
}
