/**
 * Display helpers shared by the office router's domains.
 *
 * Extracted with the domains that use them — the vessels list and the
 * dashboard both render "last seen" and both decide what counts as online, and
 * two copies of that threshold would drift into disagreeing about whether the
 * same ship is online.
 */

export function formatRelativeTime(thenMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - thenMs) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// A vessel counts as "online" if it's checked in within this window —
// shared by the Vessels list's edgeStatus badge and the dashboard's
// fleet-wide sync health, so the two views can never disagree about
// what "online" means.
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
