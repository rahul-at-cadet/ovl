import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as path from 'path';
import * as schema from '@ovl/vessel-database';
import { ReportsService } from './reports.service';
import { LockManagerService } from './lock-manager.service';

jest.setTimeout(30_000);

function makeDb() {
  const db = drizzle(new Database(':memory:'), { schema });
  migrate(db, {
    migrationsFolder: path.join(path.dirname(require.resolve('@ovl/vessel-database/package.json')), 'drizzle'),
  });
  return db;
}

/** Only the pieces deleteReport and listVersions actually touch. */
function makeService(db: any, locks = new LockManagerService()) {
  const registry = { getSchema: () => ({ schemaName: 'bunker-report', fields: [{ name: 'A', section: 'S' }] }) } as any;
  const validation = {} as any;
  return { svc: new ReportsService(db, validation, registry, locks), locks };
}

const REPORT = 'r-1';

async function seedDraft(db: any, over: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString();
  await db.insert(schema.reports).values({
    reportId: REPORT,
    versionNo: 1,
    schemaName: 'bunker-report',
    eventType: 'BunkerDelivery',
    eventTime: now,
    fields: { A: 'x' },
    state: 'draft',
    createdAt: now,
    createdBy: 'mate',
    updatedAt: now,
    submittedBy: '',
    ...over,
  });
}

describe('deleteReport', () => {
  it('removes a first draft and everything hanging off it', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    await seedDraft(db);
    const now = new Date().toISOString();
    await db.insert(schema.reportEvents).values({ reportId: REPORT, versionNo: 1, type: 'created', at: now, actor: 'mate', detail: {} });
    await db.insert(schema.chatMessages).values({ id: 'c1', reportId: REPORT, sender: 'mate', body: 'hi', sentAt: now, direction: 'ship_to_shore' });

    expect(await svc.deleteReport(REPORT, 'u1', 'mate')).toEqual({ deleted: true });

    // Children have no foreign key onto reports in this schema, so
    // nothing would clean them up — they would linger against an id that
    // no longer resolves.
    expect(await db.select().from(schema.reports)).toHaveLength(0);
    expect(await db.select().from(schema.reportEvents)).toHaveLength(0);
    expect(await db.select().from(schema.chatMessages)).toHaveLength(0);
  });

  it('refuses a report that has already been submitted once', async () => {
    // Version 2 means shore already holds version 1. Deleting here would
    // diverge from the office record rather than tidy up a mistake.
    const db = makeDb();
    const { svc } = makeService(db);
    await seedDraft(db, { versionNo: 2 });
    await expect(svc.deleteReport(REPORT, 'u1', 'mate')).rejects.toThrow(/already been submitted/i);
    expect(await db.select().from(schema.reports)).toHaveLength(1);
  });

  it('refuses a submitted report outright', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    await seedDraft(db, { state: 'submitted' });
    await expect(svc.deleteReport(REPORT, 'u1', 'mate')).rejects.toThrow(/start a correction/i);
  });

  it('refuses while another user holds a section', async () => {
    // Deleting out from under someone mid-edit is more surprising than
    // the conflict a single field change already refuses.
    const db = makeDb();
    const locks = new LockManagerService();
    const { svc } = makeService(db, locks);
    await seedDraft(db);
    locks.acquire(REPORT, 'S', 'someone-else', 'chief', 'officer');

    await expect(svc.deleteReport(REPORT, 'u1', 'mate')).rejects.toThrow(/being edited by chief/);
    expect(await db.select().from(schema.reports)).toHaveLength(1);
  });

  it('allows deletion when the only lock is the caller’s own', async () => {
    const db = makeDb();
    const locks = new LockManagerService();
    const { svc } = makeService(db, locks);
    await seedDraft(db);
    locks.acquire(REPORT, 'S', 'u1', 'mate', 'officer');

    await expect(svc.deleteReport(REPORT, 'u1', 'mate')).resolves.toEqual({ deleted: true });
    // The report is gone, so its locks must go too — otherwise they sit
    // for the full TTL against an id that no longer exists.
    expect(locks.snapshot(REPORT)).toEqual([]);
  });
});

describe('listVersions', () => {
  it('returns every version oldest first', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    await seedDraft(db, { versionNo: 1, state: 'submitted' });
    await seedDraft(db, { versionNo: 3, state: 'draft' });
    await seedDraft(db, { versionNo: 2, state: 'submitted' });

    expect((await svc.listVersions(REPORT)).map((v) => v.versionNo)).toEqual([1, 2, 3]);
  });

  it('is a not-found rather than an empty list for an unknown report', async () => {
    const db = makeDb();
    const { svc } = makeService(db);
    await expect(svc.listVersions('nope')).rejects.toThrow(/not found/i);
  });
});
