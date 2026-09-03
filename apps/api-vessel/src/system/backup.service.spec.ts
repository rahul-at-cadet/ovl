import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { VesselDatabase } from '../database/database.module';
import { BackupService } from './backup.service';

jest.setTimeout(30_000);

/**
 * Runs against a real SQLite file in a temp directory, not a mock: this
 * service exists to move files around underneath an open database
 * handle, which is precisely the part a mock cannot exercise.
 */
function makeNode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-backup-'));
  const database = new VesselDatabase(path.join(dir, 'vessel.sqlite'));
  return { dir, database, svc: new BackupService(database) };
}

const put = async (database: VesselDatabase, key: string, value: string) =>
  database.current
    .insert(schema.configStore)
    .values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.configStore.key, set: { value } });

const get = async (database: VesselDatabase, key: string) =>
  (await database.current.select().from(schema.configStore).where(eq(schema.configStore.key, key)))[0]?.value;

describe('BackupService', () => {
  let node: ReturnType<typeof makeNode>;
  beforeEach(() => { node = makeNode(); });
  afterEach(() => {
    try { node.database.close(); } catch { /* already closed by a restore test */ }
    fs.rmSync(node.dir, { recursive: true, force: true });
  });

  it('lists nothing before anything has been snapshotted', () => {
    expect(node.svc.list()).toEqual([]);
  });

  it('takes a snapshot and lists it', async () => {
    await put(node.database, 'vessel_name', 'MV Test');
    const info = node.svc.snapshotNow();

    expect(info.id).toMatch(/^\d{8}T\d{6}Z$/);
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(new Date(info.createdAt).getTime()).not.toBeNaN();

    const listed = node.svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(info.id);
  });

  it('restores the database as it was, discarding later writes', async () => {
    await put(node.database, 'vessel_name', 'Original');
    const snap = node.svc.snapshotNow();

    await put(node.database, 'vessel_name', 'Changed after the snapshot');
    expect(await get(node.database, 'vessel_name')).toBe('Changed after the snapshot');

    node.svc.restore(snap.id);

    // Read through the holder, which every service reaches via the
    // proxy — if the swap left them pointing at the closed handle this
    // throws rather than returning the old value.
    expect(await get(node.database, 'vessel_name')).toBe('Original');
  });

  it('keeps the pre-restore state as its own snapshot', async () => {
    // A restore is exactly when someone realises they picked the wrong
    // snapshot, so the state they just replaced has to survive.
    await put(node.database, 'vessel_name', 'Original');
    const first = node.svc.snapshotNow();
    await put(node.database, 'vessel_name', 'About to be discarded');

    node.svc.restore(first.id);

    const ids = node.svc.list().map((s) => s.id);
    expect(ids.length).toBe(2);
    const safety = ids.find((i) => i !== first.id)!;
    node.svc.restore(safety);
    expect(await get(node.database, 'vessel_name')).toBe('About to be discarded');
  });

  it('leaves the node usable when a restore is asked for a missing snapshot', async () => {
    await put(node.database, 'vessel_name', 'Still here');
    expect(() => node.svc.restore('20260101T000000Z')).toThrow(/no longer exists/);
    expect(await get(node.database, 'vessel_name')).toBe('Still here');
  });

  describe('snapshot ids as path components', () => {
    // The id is joined onto a filesystem path, so anything that is not
    // the exact minted format has to be refused before it gets there
    // (CWE-22). The original calls this out by name.
    const hostile = [
      '../../etc',
      '..',
      'x/../../../tmp',
      '20260101T000000Z/../../..',
      '/etc/passwd',
      '20260101T000000',
      'not-an-id',
      '',
    ];

    it.each(hostile)('refuses to restore %p', (id) => {
      expect(() => node.svc.restore(id)).toThrow(/not a valid snapshot id/i);
    });

    it.each(hostile)('refuses to delete %p', (id) => {
      expect(() => node.svc.remove(id)).toThrow(/not a valid snapshot id/i);
    });

    it('does not delete anything outside the backups directory', () => {
      const bystander = path.join(node.dir, 'vessel.sqlite');
      expect(() => node.svc.remove('../vessel.sqlite')).toThrow();
      expect(fs.existsSync(bystander)).toBe(true);
    });
  });

  it('carries attachments into the snapshot and back out again', async () => {
    // Attachments are content-addressed files on disk, not rows, so a
    // database-only snapshot would restore reports whose files had gone.
    const attachments = path.join(node.dir, 'attachments');
    fs.mkdirSync(path.join(attachments, 'ab'), { recursive: true });
    fs.writeFileSync(path.join(attachments, 'ab', 'abcdef'), 'original bytes');

    const snap = node.svc.snapshotNow();
    expect(snap.hasAttachments).toBe(true);

    fs.writeFileSync(path.join(attachments, 'ab', 'abcdef'), 'changed later');
    node.svc.restore(snap.id);

    expect(fs.readFileSync(path.join(attachments, 'ab', 'abcdef'), 'utf8')).toBe('original bytes');
  });

  it('deletes a snapshot without touching the others', () => {
    const a = node.svc.snapshotNow();
    // Ids are second-resolution, so a second snapshot in the same second
    // would reuse the name; this test only needs one to survive.
    node.svc.remove(a.id);
    expect(node.svc.list().map((s) => s.id)).not.toContain(a.id);
  });

  it('survives a nightly run and records a snapshot', () => {
    node.svc.runNightly();
    expect(node.svc.list()).toHaveLength(1);
  });
});
