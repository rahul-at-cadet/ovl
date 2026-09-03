/**
 * Renders a stored timestamp as RFC3339/ISO-8601.
 *
 * Postgres columns read through drizzle's `mode: 'string'` come back in
 * Postgres's own rendering — "2026-08-28 07:33:00.099+00", with a space
 * separator and a two-digit offset. That string is not ISO-8601, and it
 * leaks straight through the API to two kinds of consumer that both
 * mishandle it:
 *
 *  - Browsers. V8 parses it, but Safari's `Date` rejects it outright, so
 *    any screen calling `new Date(value)` renders "Invalid Date" for
 *    every row on a Mac or an iPad.
 *  - The vessel. It stores some of these in columns its own schema
 *    documents as RFC3339 and then orders on them as strings; a store
 *    holding both forms sorts them against each other rather than
 *    chronologically, because 'T' sorts after a space.
 *
 * Unparseable input is passed through untouched rather than turned into
 * a fabricated date: a wrong timestamp that looks right is worse in an
 * audit trail than one that visibly is not a date.
 */
export function toIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Nullable columns keep their null rather than becoming "Invalid Date". */
export function toIsoOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}
