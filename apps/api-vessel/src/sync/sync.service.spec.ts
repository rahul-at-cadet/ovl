import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as path from 'path';
import * as schema from '@ovl/vessel-database';
import { SyncService } from './sync.service';

/**
 * Runs against a real in-memory SQLite with the package's own migrations
 * applied — not a mocked query builder. The bug this covers was that a
 * failing config pull still reported success, so a test that stubs the
 * database away would reproduce the mock rather than the behaviour.
 */
function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: path.join(
      path.dirname(require.resolve('@ovl/vessel-database/package.json')),
      'drizzle',
    ),
  });
  return db;
}

const VESSEL_ID = '11111111-1111-4111-8111-111111111111';

async function seedIdentity(db: any) {
  const now = new Date().toISOString();
  for (const [key, value] of [
    ['vessel_id', VESSEL_ID],
    ['vessel_name', 'MV Test'],
    ['imo_number', '1234567'],
    ['shore_url', 'http://office/trpc'],
  ]) {
    await db.insert(schema.configStore).values({ key, value, updatedAt: now });
  }
}

/** Minimal shore stub: one pullConfig response, recorded calls. */
function makeTrpc(pullConfig: (input: any) => any) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      sync: {
        pullConfig: { query: async (input: any) => { calls.push(input); return pullConfig(input); } },
        pushEvents: { mutate: async () => ({ success: true, processedCount: 0 }) },
      },
    },
  } as any;
}

const auth = { listRosterSummary: async () => [] } as any;

describe('SyncService', () => {
  it('reports a cycle as successful and records the applied bundle', async () => {
    const db = makeDb();
    await seedIdentity(db);
    const bundle = { bundleId: 'b-1', versionNo: 7, schemas: [] };
    const svc = new SyncService(
      makeTrpc(() => ({ bundle, syncedAt: new Date().toISOString(), vessel: { id: VESSEL_ID, name: 'MV Test', imo: '1234567' } })),
      auth,
      db,
    );

    await svc.handleCron();
    const status = await svc.getStatus();

    expect(status.lastError).toBeNull();
    expect(status.lastSuccess).not.toBeNull();
    expect(status.appliedBundleId).toBe('b-1');
    expect(status.appliedBundleVersion).toBe(7);

    const runs = await svc.getHistory();
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('success');
    expect(runs[0].bundleIdAfter).toBe('b-1');
  });

  // The regression this suite exists for.
  it('does NOT report success when the config pull fails', async () => {
    const db = makeDb();
    await seedIdentity(db);
    const svc = new SyncService(
      makeTrpc(() => { throw new Error('Vessel is not registered with this office.'); }),
      auth,
      db,
    );

    await svc.handleCron();
    const status = await svc.getStatus();

    expect(status.lastSuccess).toBeNull();
    expect(status.lastError).toMatch(/not registered/);
    expect(status.configError).toMatch(/Config pull failed/);
    expect(status.appliedBundleId).toBeNull();

    const runs = await svc.getHistory();
    expect(runs[0].outcome).toBe('partial');
    expect(runs[0].configError).toMatch(/not registered/);
  });

  it('distinguishes "no bundle assigned" from a failure', async () => {
    const db = makeDb();
    await seedIdentity(db);
    const svc = new SyncService(
      makeTrpc(() => ({ bundle: null, syncedAt: new Date().toISOString() })),
      auth,
      db,
    );

    await svc.handleCron();
    const status = await svc.getStatus();

    expect(status.lastError).toBeNull();
    expect(status.configNotice).toMatch(/no config bundle assigned/i);
    expect(status.appliedBundleId).toBeNull();
    expect((await svc.getHistory())[0].outcome).toBe('success');
  });

  it('sends its own name and IMO, and flags a divergence from shore', async () => {
    const db = makeDb();
    await seedIdentity(db);
    const trpc = makeTrpc(() => ({
      bundle: null,
      syncedAt: new Date().toISOString(),
      vessel: { id: VESSEL_ID, name: 'Shore Name', imo: '1234567' },
    }));
    const svc = new SyncService(trpc, auth, db);

    await svc.handleCron();

    expect(trpc.calls[0].vesselName).toBe('MV Test');
    expect(trpc.calls[0].imoNumber).toBe('1234567');
    expect(trpc.calls[0].runId).toEqual(expect.any(String));

    const status = await svc.getStatus();
    expect(status.officeVesselName).toBe('Shore Name');
    expect(status.nameMismatch).toBe(true);
  });

  it('re-applies a bundle whose id changed even at the same versionNo', async () => {
    const db = makeDb();
    await seedIdentity(db);
    let bundle: any = { bundleId: 'b-1', versionNo: 1, schemas: [] };
    const svc = new SyncService(
      makeTrpc(() => ({ bundle, syncedAt: new Date().toISOString() })),
      auth,
      db,
    );

    await svc.handleCron();
    expect((await svc.getStatus()).appliedBundleId).toBe('b-1');

    // Same versionNo, different bundle — the old skip compared version only
    // and would have left the vessel pinned to b-1.
    bundle = { bundleId: 'b-2', versionNo: 1, schemas: [] };
    await svc.handleCron();

    expect((await svc.getStatus()).appliedBundleId).toBe('b-2');
  });

  it('marks a manual sync distinctly from the cron cycle', async () => {
    const db = makeDb();
    await seedIdentity(db);
    const svc = new SyncService(
      makeTrpc(() => ({ bundle: null, syncedAt: new Date().toISOString() })),
      auth,
      db,
    );

    await svc.handleCron();
    await svc.syncNow();

    const runs = await svc.getHistory();
    expect(runs.map((r) => r.trigger).sort()).toEqual(['cron', 'manual']);
  });

  it('skips the pull entirely when the vessel is not enrolled', async () => {
    const db = makeDb();
    const trpc = makeTrpc(() => ({ bundle: null, syncedAt: new Date().toISOString() }));
    const svc = new SyncService(trpc, auth, db);

    await svc.handleCron();

    expect(trpc.calls).toHaveLength(0);
    const status = await svc.getStatus();
    expect(status.enrolled).toBe(false);
    expect(status.lastError).toBeNull();
  });
});
