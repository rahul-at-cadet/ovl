import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

/**
 * The uuid and timestamp shapes the router validates client input
 * against. Kept as a test on the patterns themselves because the
 * failure they prevent is not a wrong answer but a 500: an unvalidated
 * value reached Postgres, which threw, and the reply carried the
 * database's own message — "invalid input syntax for type uuid" — back
 * to the caller across nine procedures.
 */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}(:?\d{2})?)?$/;

/** Mirrors parseTimestampFilter's checks. */
function acceptsTimestamp(value: string): boolean {
  if (!TIMESTAMP_SHAPE.test(value) || Number.isNaN(new Date(value).getTime())) return false;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

describe('uuid wire validation', () => {
  const check = TypeCompiler.Compile(Type.String({ pattern: UUID_PATTERN }));

  it('accepts a real vessel id', () => {
    expect(check.Check('01a01028-cc4d-78ba-9b44-fff044383b5f')).toBe(true);
  });

  it.each([
    'nope',
    '',
    '01a01028-cc4d-78ba-9b44',
    '01a01028cc4d78ba9b44fff044383b5f',
    "01a01028-cc4d-78ba-9b44-fff044383b5f' OR '1'='1",
    '../../etc/passwd',
    '01a01028-cc4d-78ba-9b44-fff044383b5g',
  ])('rejects %p before it reaches the database', (value) => {
    expect(check.Check(value)).toBe(false);
  });
});

describe('timestamp filter validation', () => {
  it.each([
    '2026-09-03T07:00:00.000Z',
    '2026-09-03T07:00:00+00:00',
    // Postgres's own rendering, which a cursor could still carry.
    '2026-09-03 07:00:00+00',
    '2026-09-03T07:00',
    '2024-02-29T00:00:00Z',
  ])('accepts %p', (value) => {
    expect(acceptsTimestamp(value)).toBe(true);
  });

  it.each([
    // Postgres parses these as date literals, so an unvalidated filter
    // silently applied a range the caller never asked for and reported
    // success.
    'yesterday',
    'now',
    'today',
    'infinity',
    // Shaped correctly and impossible — no pattern catches these, and
    // they reached Postgres and threw.
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-09-32T00:00:00Z',
    'soon',
    '',
  ])('rejects %p', (value) => {
    expect(acceptsTimestamp(value)).toBe(false);
  });
});
