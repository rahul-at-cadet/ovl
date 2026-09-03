import { ConfigBundleService } from './config-bundle.service';

/**
 * Records the SQL the service builds rather than executing it. What
 * matters here is which clauses are emitted for a given set of filters
 * and sort — that the resulting query returns rows is covered by driving
 * the real endpoint against Postgres.
 */
function makeDb(rows: any[] = []) {
  const seen: any = { where: [], orderBy: [], limit: null, groupBy: [] };
  const chain: any = {
    from: () => chain,
    leftJoin: () => chain,
    where: (w: any) => { seen.where.push(w); return chain; },
    groupBy: (...g: any[]) => { seen.groupBy.push(g); return chain; },
    orderBy: (...o: any[]) => { seen.orderBy.push(o); return Object.assign(Promise.resolve(rows), chain); },
    limit: (n: number) => { seen.limit = n; return Promise.resolve(rows); },
    then: (...a: any[]) => Promise.resolve(rows).then(...a),
  };
  return { db: { select: () => chain, selectDistinct: () => chain } as any, seen };
}

/**
 * Flattens a drizzle SQL fragment to the literal strings it will emit.
 * The objects are self-referential, so this walks the chunks rather than
 * serialising them.
 */
function render(node: any, depth = 0): string {
  if (node == null || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => render(n, depth + 1)).join(' ');
  if (typeof node.value === 'string') return node.value;
  // StringChunk holds its text as an array of parts, not a string.
  if (Array.isArray(node.value)) return node.value.join(' ');
  if (Array.isArray(node.queryChunks)) return render(node.queryChunks, depth + 1);
  return '';
}

describe('syncHistory paging', () => {
  const cursor = { receivedAt: '2026-09-01T00:00:00.000Z', id: 'abc' };

  it('seeks backwards when sorted newest first', async () => {
    const { db, seen } = makeDb();
    const svc = new ConfigBundleService(db);
    await svc.syncHistory({}, 50, cursor, 'newest');
    // A descending list pages by taking rows strictly *before* the last
    // one read.
    expect(render(seen.where[0])).toContain('<');
  });

  it('seeks forwards when sorted oldest first', async () => {
    // The comparison has to follow the sort. Paging an ascending list
    // with a descending seek walks off the front and returns nothing —
    // the page just stops loading with rows still to come.
    const { db, seen } = makeDb();
    const svc = new ConfigBundleService(db);
    await svc.syncHistory({}, 50, cursor, 'oldest');
    const sql = render(seen.where[0]);
    expect(sql).toContain('>');
    expect(sql).not.toContain('<');
  });

  it('caps the page size however large a limit is asked for', async () => {
    const { db, seen } = makeDb();
    const svc = new ConfigBundleService(db);
    await svc.syncHistory({}, 100_000);
    expect(seen.limit).toBe(200);
  });

  it('never returns a zero-row page', async () => {
    const { db, seen } = makeDb();
    const svc = new ConfigBundleService(db);
    await svc.syncHistory({}, 0);
    expect(seen.limit).toBe(1);
  });
});

describe('syncHistory rows', () => {
  const row = (over: any = {}) => ({
    id: 'r1',
    runId: 'run-1',
    vesselId: 'v1',
    receivedAt: '2026-09-01T00:00:00.000Z',
    outcome: 'served',
    resolvedBundleId: 'b1',
    resolvedBundleVersion: 3,
    reportedName: 'MV Test',
    reportedImo: '1234567',
    note: null,
    knownVesselName: 'MV Test',
    knownVesselImo: '1234567',
    ...over,
  });

  it('labels a vessel office cannot resolve by what the ship called itself', async () => {
    // This is precisely the row an operator is hunting for, so it must
    // not render as a blank name.
    const { db } = makeDb([row({ knownVesselName: null, knownVesselImo: null })]);
    const svc = new ConfigBundleService(db);
    const [out] = await svc.syncHistory();
    expect(out.displayName).toBe('MV Test');
  });

  it('flags name and IMO divergence between shore and ship', async () => {
    const { db } = makeDb([row({ knownVesselName: 'Shore Name', knownVesselImo: '7654321' })]);
    const svc = new ConfigBundleService(db);
    const [out] = await svc.syncHistory();
    expect(out.nameMismatch).toBe(true);
    expect(out.imoMismatch).toBe(true);
  });

  it('marks only a served check-in as healthy', async () => {
    const { db } = makeDb([row(), row({ outcome: 'noBundle' }), row({ outcome: 'unknownVessel' })]);
    const svc = new ConfigBundleService(db);
    const out = await svc.syncHistory();
    expect(out.map((r) => r.healthy)).toEqual([true, false, false]);
  });
});

describe('syncMetrics', () => {
  it('derives failed and successRate from the served count', async () => {
    const { db } = makeDb([{ total: 10, vessels: 3, firstAt: 'a', lastAt: 'b', served: 7 }]);
    const svc = new ConfigBundleService(db);
    const m = await svc.syncMetrics();
    expect(m.failed).toBe(3);
    expect(m.successRate).toBe(70);
  });

  it('reports no success rate rather than 0% when nothing matched', async () => {
    // 0% reads as "everything failed"; the truth is that there is
    // nothing to rate.
    const { db } = makeDb([{ total: 0, vessels: 0, firstAt: null, lastAt: null, served: 0 }]);
    const svc = new ConfigBundleService(db);
    const m = await svc.syncMetrics();
    expect(m.total).toBe(0);
    expect(m.successRate).toBeNull();
  });
});
