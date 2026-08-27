import { createHash } from 'node:crypto';

/**
 * Canonical JSON and content checksum — a deliberate copy of
 * `@ovl/database/src/form-schema-checksum.ts`.
 *
 * Duplicated rather than imported because the office package pulls in `pg`,
 * and the vessel runs on SQLite with no Postgres driver anywhere near it. This
 * follows the same vendored-duplicate precedent as the rest of the
 * office/vessel-shared display and validation logic in this port.
 *
 * The two copies MUST agree. They are pinned together by a shared golden
 * value: `form-schema-checksum.spec.ts` on both sides asserts the same fixture
 * hashes to the same string, so a change to one without the other fails a test
 * rather than silently making every sync look like a corrupted payload.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Stable identity for a schema document.
 *
 * Array order is preserved — field order drives render order, so two documents
 * differing only in field order are genuinely different documents.
 */
export function formSchemaChecksum(document: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex')}`;
}
