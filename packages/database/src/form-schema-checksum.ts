import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialisation: object keys sorted, no insignificant whitespace.
 *
 * Array order is preserved. That is not an oversight — field order is
 * meaningful in a form schema (it drives render order), so two documents that
 * differ only in field order are genuinely different documents.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members vanish under JSON.stringify, so drop them here too
    // rather than emitting a key with no value.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Stable identity for a schema or enum document.
 *
 * Computed over the canonical form rather than the raw bytes so that office
 * and vessel agree on "is this the same schema?" without needing byte-identical
 * transport. A document that survives a JSON round trip, a jsonb column, or a
 * re-serialisation with different key order still hashes the same — which is
 * what makes it usable as the sync diff key, where the two sides never see the
 * same bytes.
 *
 * Prefixed with the algorithm so a future migration to something else can be
 * told apart from a mismatch.
 */
export function formSchemaChecksum(document: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex')}`;
}
