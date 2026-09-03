import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

// Ports ovl/vessel/httpapi/locks.go's lockManager (architecture 9.5).
// In-memory only, on purpose — it does not survive a process restart,
// same as the original: a restart releasing every held lock is correct
// behavior, not a data-loss risk, since nothing about a lock itself is
// durable state.
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches the original's lockTTL

export interface SectionLock {
  reportId: string;
  section: string;
  userId: string;
  username: string;
  role: string;
  acquiredAt: string; // ISO
  renewedAt: string; // ISO
}

function isExpired(lock: SectionLock, now: number): boolean {
  return now > new Date(lock.renewedAt).getTime() + LOCK_TTL_MS;
}

function key(reportId: string, section: string): string {
  return `${reportId} ${section}`;
}

@Injectable()
export class LockManagerService {
  private readonly logger = new Logger(LockManagerService.name);
  private readonly locks = new Map<string, SectionLock>();

  /**
   * Claims reportId/section for the caller, succeeding if it's
   * unlocked, expired, or already held by the same user (a renewal —
   * acquiredAt is preserved across a renewal, only renewedAt advances).
   * Returns ok=false and the existing lock if it's held by someone
   * else and not expired.
   */
  acquire(reportId: string, section: string, userId: string, username: string, role: string): { lock: SectionLock; ok: boolean } {
    const now = Date.now();
    const k = key(reportId, section);
    const existing = this.locks.get(k);
    if (existing && existing.userId !== userId && !isExpired(existing, now)) {
      return { lock: existing, ok: false };
    }
    const acquiredAt = existing && existing.userId === userId ? existing.acquiredAt : new Date(now).toISOString();
    const lock: SectionLock = { reportId, section, userId, username, role, acquiredAt, renewedAt: new Date(now).toISOString() };
    this.locks.set(k, lock);
    return { lock, ok: true };
  }

  /** Releases reportId/section's lock, but only if userId is the current holder. */
  release(reportId: string, section: string, userId: string): SectionLock | null {
    const k = key(reportId, section);
    const existing = this.locks.get(k);
    if (!existing || existing.userId !== userId) return null;
    this.locks.delete(k);
    return existing;
  }

  /** Master-only force-release, regardless of holder — authorization is the caller's job. */
  forceRelease(reportId: string, section: string): SectionLock | null {
    const k = key(reportId, section);
    const existing = this.locks.get(k);
    if (!existing) return null;
    this.locks.delete(k);
    return existing;
  }

  /** The current unexpired lock for reportId/section, if any — the backstop saveSection checks before persisting. */
  holder(reportId: string, section: string): SectionLock | null {
    const existing = this.locks.get(key(reportId, section));
    if (!existing || isExpired(existing, Date.now())) return null;
    return existing;
  }

  /** Every active (unexpired) lock for reportId, sorted by section for a stable response. */
  snapshot(reportId: string): SectionLock[] {
    const now = Date.now();
    const out: SectionLock[] = [];
    for (const [k, lock] of this.locks) {
      if (!k.startsWith(reportId + ' ') || isExpired(lock, now)) continue;
      out.push(lock);
    }
    return out.sort((a, b) => a.section.localeCompare(b.section));
  }

  /**
   * Drops every lock on one report, held or not.
   *
   * Only for a report that no longer exists — deleting a draft leaves its
   * locks pointing at nothing, and they would otherwise sit there for the
   * full TTL blocking a new report that happened to reuse the id.
   */
  releaseAll(reportId: string): void {
    for (const k of this.locks.keys()) {
      if (k.startsWith(reportId + ' ')) this.locks.delete(k);
    }
  }

  /**
   * Removes every lock expired as of now, across all reports.
   *
   * Unlike the original's timer-driven sweep (which also broadcasts each
   * release over SSE), this port has no live-push transport — the client
   * polls, so an expired lock simply stops appearing in the next
   * locks.list call. Correctness never depended on this running.
   *
   * Memory did, and this method's own comment used to claim it ran
   * periodically while nothing ever called it. Every (report, section)
   * pair ever locked therefore stayed in the map for the life of the
   * process — small per entry, unbounded over a long voyage. It is now
   * actually scheduled.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [k, lock] of [...this.locks]) {
      if (isExpired(lock, now)) {
        this.locks.delete(k);
        removed++;
      }
    }
    if (removed > 0) this.logger.debug(`Swept ${removed} expired section lock(s).`);
  }

  /** How many entries the map is holding — for the sweep's own tests. */
  size(): number {
    return this.locks.size;
  }
}
