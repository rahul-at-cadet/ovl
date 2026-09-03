import { SchemaVersionsService } from './schema-versions.service';

/**
 * Covers listSince, the cursor stream that feeds published schemas down
 * to vessels. The cursor semantics are what stop a ship either re-pulling
 * the whole archive every thirty seconds or skipping a version outright,
 * so they are worth pinning independently of the live check.
 */
function makeDb(rows: any[]) {
  const calls: any = {};
  const chain: any = {
    from: () => chain,
    where: (w: any) => { calls.where = w; return chain; },
    orderBy: () => chain,
    limit: (n: number) => { calls.limit = n; return Promise.resolve(rows); },
  };
  return { db: { select: () => chain } as any, calls };
}

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  schemaName: 'bunker-report',
  version: '3.14',
  source: 'office-authored',
  content: Buffer.from(JSON.stringify({ schemaName: 'bunker-report', fields: [{ name: 'A' }] }), 'utf-8'),
  // Exactly what Postgres hands back in drizzle's string mode.
  publishedAt: '2026-09-03 05:49:46.971+00',
  cursor: 12,
  ...over,
});

describe('SchemaVersionsService.listSince', () => {
  it('renders publishedAt as RFC3339 rather than passing Postgres form through', async () => {
    // The vessel stores this in a column documented as RFC3339 and picks
    // the newest version by string-ordering it. A store holding both
    // forms would sort them against each other, not chronologically.
    const { db } = makeDb([row()]);
    const svc = new SchemaVersionsService(db);
    const [out] = await svc.listSince(0);
    expect(out.publishedAt).toBe('2026-09-03T05:49:46.971Z');
    expect(new Date(out.publishedAt).getTime()).toBe(new Date('2026-09-03 05:49:46.971+00').getTime());
  });

  it('returns the document verbatim and the cursor as a string', async () => {
    // cursor is a bigint identity column; it crosses the wire as a string
    // the same way the chat and remark cursors do.
    const { db } = makeDb([row()]);
    const svc = new SchemaVersionsService(db);
    const [out] = await svc.listSince(0);
    expect(out.cursor).toBe('12');
    expect(JSON.parse(out.content).schemaName).toBe('bunker-report');
  });

  it('bounds how much one check-in can pull', async () => {
    // A vessel meeting an office with a long publishing history catches
    // up over several cycles rather than pulling the archive down in one
    // satellite pass.
    const { db, calls } = makeDb([]);
    const svc = new SchemaVersionsService(db);
    await svc.listSince(0);
    expect(calls.limit).toBe(25);
    await svc.listSince(0, 5);
    expect(calls.limit).toBe(5);
  });

  it('reports an absent cursor as 0 rather than null', async () => {
    const { db } = makeDb([row({ cursor: null })]);
    const svc = new SchemaVersionsService(db);
    const [out] = await svc.listSince(0);
    expect(out.cursor).toBe('0');
  });
});
