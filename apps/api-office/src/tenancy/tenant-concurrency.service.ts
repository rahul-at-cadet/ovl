import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TENANCY_OPTIONS, type ResolvedTenancyOptions } from './tenancy.constants';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface TenantSlot {
  active: number;
  queue: Waiter[];
}

/**
 * Per-tenant admission control in front of the shared connection pool.
 *
 * Schema-per-tenant isolates *data*, not *resources*: every tenant draws from
 * the same pool, so one operator running a heavy report hour can queue every
 * connection and slow the entire fleet. This caps how many transactions any
 * single tenant may have in flight, so a hot tenant slows down alone.
 *
 * It also converts overload into a clean, fast failure. A request that waits
 * longer than the queue timeout is rejected with 503 rather than left to sit —
 * an unbounded queue of waiting requests is what turns a busy minute into a
 * cascading outage, and long queues widen the windows in which every other
 * concurrency bug becomes reachable.
 */
@Injectable()
export class TenantConcurrencyService {
  private readonly logger = new Logger(TenantConcurrencyService.name);
  private readonly slots = new Map<string, TenantSlot>();

  constructor(
    @Inject(TENANCY_OPTIONS) private readonly options: ResolvedTenancyOptions,
  ) {}

  /** Runs `fn` once this tenant is under its concurrency ceiling. */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(tenantId);
    try {
      return await fn();
    } finally {
      this.release(tenantId);
    }
  }

  /** Current in-flight and queued counts, for metrics and tests. */
  stats(tenantId: string): { active: number; queued: number } {
    const slot = this.slots.get(tenantId);
    return { active: slot?.active ?? 0, queued: slot?.queue.length ?? 0 };
  }

  private acquire(tenantId: string): Promise<void> {
    const slot = this.slots.get(tenantId) ?? { active: 0, queue: [] };
    this.slots.set(tenantId, slot);

    if (slot.active < this.options.maxConcurrentPerTenant) {
      slot.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = slot.queue.findIndex((w) => w.timer === timer);
        if (index !== -1) slot.queue.splice(index, 1);
        this.pruneIfIdle(tenantId, slot);
        this.logger.warn(
          `Shedding request for tenant ${tenantId}: waited ${this.options.tenantQueueTimeoutMillis}ms ` +
            `with ${slot.active} transactions already in flight`,
        );
        reject(
          new ServiceUnavailableException(
            'This account has too many requests in flight. Please retry in a moment.',
          ),
        );
      }, this.options.tenantQueueTimeoutMillis);

      // Do not keep the event loop alive purely to time out a queued request.
      timer.unref?.();

      slot.queue.push({ resolve, reject, timer });
    });
  }

  private release(tenantId: string): void {
    const slot = this.slots.get(tenantId);
    if (!slot) return;

    const next = slot.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      // `active` stays as it is: this release hands its slot straight to the
      // waiter rather than decrementing and re-incrementing.
      next.resolve();
      return;
    }

    slot.active = Math.max(0, slot.active - 1);
    this.pruneIfIdle(tenantId, slot);
  }

  /**
   * Drops the bookkeeping entry once a tenant goes quiet.
   *
   * Without this the map grows by one entry per tenant ever seen and never
   * shrinks — a slow leak that only shows up on a long-lived process serving
   * many tenants, which is exactly the deployment this design targets.
   */
  private pruneIfIdle(tenantId: string, slot: TenantSlot): void {
    if (slot.active === 0 && slot.queue.length === 0) {
      this.slots.delete(tenantId);
    }
  }
}
