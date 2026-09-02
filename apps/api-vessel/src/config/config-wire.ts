/**
 * Config bundle wire format — ports ovl/pkg/configwire/bundle.go.
 *
 * The office serialises a bundle at a declared wire version and the
 * vessel decodes it. The version gate is the whole point of having a
 * named format: a vessel that meets a newer office, or that still holds
 * a pre-format bundle in local storage, must fall back to its built-in
 * defaults rather than half-applying a document it does not understand.
 *
 * The port previously had no decoder at all — the bundle was read with a
 * bare JSON.parse whose only failure mode was malformed JSON, so a
 * version-0 or version-2 document was applied as though it were
 * understood, silently and with no way to notice.
 */

import type { FieldEvents, FieldPolicy } from '../validation/types';

/** The highest wire version this build can read. */
export const WIRE_VERSION = 1;

// policy/events carry the validation layer's own types rather than a
// loose Record: this is the boundary where an untrusted document becomes
// typed data, so stating the real shape here is the point. The gate
// above only checks the version — these remain assertions about a
// document office produced, not validated field-by-field.
export type WireSchemaConfig = {
  schemaName: string;
  version: string;
  policy: FieldPolicy;
  prefill: Record<string, unknown>;
  events: FieldEvents;
};

export type WireBundle = {
  wireVersion: number;
  bundleId: string;
  versionNo: number;
  publishedAt: string;
  schemas: WireSchemaConfig[];
  regulatoryProfiles?: unknown;
  maxGapHours?: number;
  ruleSeverities?: unknown;
  defaultRoleNames?: string[];
};

export class UnsupportedBundleError extends Error {}

/**
 * Parses and version-checks a stored bundle.
 *
 * Throws rather than returning null so the two failure modes stay
 * distinguishable to the caller: malformed JSON and an unreadable
 * version are both "no usable bundle", but only the second is worth
 * warning an operator about — it means office is ahead of this node.
 */
export function decodeBundle(data: string): WireBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (e: any) {
    throw new UnsupportedBundleError(`config bundle is not readable JSON: ${e.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new UnsupportedBundleError('config bundle is not an object');
  }

  const bundle = parsed as Partial<WireBundle>;
  const wireVersion = bundle.wireVersion;

  // `undefined` is the pre-configwire case and lands here alongside 0 —
  // both mean "this document predates the format", which is exactly what
  // the gate exists to refuse.
  if (typeof wireVersion !== 'number' || wireVersion < 1 || wireVersion > WIRE_VERSION) {
    throw new UnsupportedBundleError(
      `unsupported config bundle wire version ${String(wireVersion)} (this build understands 1..${WIRE_VERSION})`,
    );
  }

  return { ...bundle, wireVersion, schemas: bundle.schemas ?? [] } as WireBundle;
}

/**
 * The per-schema config for one schema, or undefined.
 *
 * Ports Bundle.SchemaConfigFor, but keeps the port's own `.json`-suffix
 * tolerance: office stores bare schema names in the bundle while the
 * vessel's registry keys on the filename, and that normalisation already
 * existed at the call site.
 */
export function schemaConfigFor(bundle: WireBundle, schemaName: string): WireSchemaConfig | undefined {
  const bare = schemaName.replace(/\.json$/, '');
  return bundle.schemas.find((s) => s.schemaName === bare);
}
