/**
 * The disaster-recovery bundle wire format — ports ovl/pkg/restorebundle.
 *
 * One vessel's full report history, audit trail, chat and currently
 * assigned config bundle, JSON-encoded and then encrypted with
 * ./backup-crypto against that vessel's own DR public key. Office
 * produces it; the vessel decrypts and applies it after losing its local
 * data.
 *
 * The Go original keeps this in a package both binaries import. The two
 * Node apps share no code (office speaks Postgres, the vessel speaks
 * SQLite, and neither depends on the other), so the reader's copy lives
 * at apps/api-vessel/src/system/restore-bundle.ts and must be changed in
 * lockstep with this one — the same arrangement password.ts and
 * readPosition already use across the two apps.
 *
 * Attachments are deliberately excluded, exactly as in the original:
 * they are content-addressed blobs with their own chunked transfer
 * shape, not something to inline into a single JSON document. That is a
 * stated scope boundary, not an oversight.
 */

/** Bumped only on a breaking change to the shapes below. */
export const RESTORE_BUNDLE_VERSION = 1;

export interface RestoreBundleReportVersion {
  reportId: string;
  versionNo: number;
  schemaKind: string;
  schemaVersion: string;
  eventType: string;
  state: string;
  eventTime: string;
  fields: Record<string, unknown>;
  submittedAt: string | null;
  receivedAt: string;
}

export interface RestoreBundleEvent {
  reportId: string;
  versionNo: number;
  type: string;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
}

export interface RestoreBundleChatMessage {
  id: string;
  reportId: string;
  sender: string;
  body: string;
  sentAt: string;
  /** Vessel-local convention, translated at this boundary as sync does. */
  direction: 'ship_to_shore' | 'shore_to_ship';
}

export interface RestoreBundleReport {
  reportId: string;
  versions: RestoreBundleReportVersion[];
  events: RestoreBundleEvent[];
  chat: RestoreBundleChatMessage[];
}

/**
 * Snapshot of the vessel's resolved config bundle at generation time —
 * the same wire shape sync.pullConfig already returns, so importing a
 * restore bundle installs config through the identical path an ordinary
 * sync would have used, just carried in this envelope instead.
 * Null when no assignment (vessel- or group-scoped) covers the vessel:
 * a real, reachable state, not an error.
 */
export interface RestoreBundleConfig {
  bundleId: string;
  versionNo: number;
  content: unknown;
  publishedAt: string;
}

export interface RestoreBundle {
  wireVersion: number;
  vesselId: string;
  vesselName: string;
  vesselImo: string;
  generatedAt: string;
  reports: RestoreBundleReport[];
  configBundle: RestoreBundleConfig | null;
}
