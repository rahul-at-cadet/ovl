/**
 * The disaster-recovery bundle wire format, reader side.
 *
 * Mirrors apps/api-office/src/vessels/logic/restore-bundle.ts, which
 * documents the format and is the producer; the two apps share no code,
 * so both copies must change together. Ports ovl/pkg/restorebundle,
 * which the Go original shares between its two binaries.
 *
 * Deliberately not a structural copy of the writer's types: everything
 * here comes off the wire, so the decoder below is what turns an
 * untrusted document into these shapes, and the fields it does not need
 * are simply absent rather than asserted.
 */

/** The highest bundle wire version this build can apply. */
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
  direction: 'ship_to_shore' | 'shore_to_ship';
}

export interface RestoreBundleReport {
  reportId: string;
  versions: RestoreBundleReportVersion[];
  events: RestoreBundleEvent[];
  chat: RestoreBundleChatMessage[];
}

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

export class UnsupportedRestoreBundleError extends Error {}

/**
 * Parses and version-checks decrypted bundle bytes.
 *
 * The same shape of gate config-wire.ts applies to config bundles, and
 * for the same reason: a node that meets a newer office must refuse the
 * document outright rather than half-apply one it does not understand.
 * Here the stakes are higher — this writes directly into the report
 * store — so the report list is also structurally checked before
 * anything is inserted, instead of trusting the envelope's shape.
 */
export function decodeRestoreBundle(json: string): RestoreBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: any) {
    throw new UnsupportedRestoreBundleError(`restore bundle is not readable JSON: ${e.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new UnsupportedRestoreBundleError('restore bundle is not an object');
  }

  const bundle = parsed as Partial<RestoreBundle>;
  const wireVersion = bundle.wireVersion;
  // `undefined` lands here alongside 0: both mean "this document
  // predates the format", which is exactly what the gate is for.
  if (typeof wireVersion !== 'number' || wireVersion < 1 || wireVersion > RESTORE_BUNDLE_VERSION) {
    throw new UnsupportedRestoreBundleError(
      `unsupported restore bundle wire version ${String(wireVersion)} (this build understands 1..${RESTORE_BUNDLE_VERSION})`,
    );
  }
  if (!Array.isArray(bundle.reports)) {
    throw new UnsupportedRestoreBundleError('restore bundle carries no reports list');
  }
  for (const report of bundle.reports) {
    if (!report || typeof report.reportId !== 'string' || !Array.isArray(report.versions)) {
      throw new UnsupportedRestoreBundleError('restore bundle contains a malformed report entry');
    }
  }

  return {
    wireVersion,
    vesselId: bundle.vesselId ?? '',
    vesselName: bundle.vesselName ?? '',
    vesselImo: bundle.vesselImo ?? '',
    generatedAt: bundle.generatedAt ?? '',
    reports: bundle.reports,
    configBundle: bundle.configBundle ?? null,
  };
}
