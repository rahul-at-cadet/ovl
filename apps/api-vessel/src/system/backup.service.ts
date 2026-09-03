import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { VesselDatabase } from '../database/database.module';
import { attachmentsDir } from './paths';

/**
 * Local snapshots — ports ovl/vessel/httpapi/backup.go.
 *
 * The port had only "download a copy of the database"; the original also
 * keeps timestamped snapshots on the vessel itself and can roll back to
 * one. That matters because the office-side restore bundle (see
 * RestoreBundleService) only carries what shore holds: drafts, local
 * attachments and anything not yet synced exist nowhere else, so without
 * a local snapshot they are simply gone.
 */

/**
 * Snapshot folder name, and the only shape a restore will accept.
 *
 * Reused as the id validator rather than a separate regex, so the format
 * ids are minted in and the format they are checked against cannot drift
 * apart — the id becomes a filesystem path component below, and a
 * "../"-laden one would otherwise escape the backups directory (CWE-22).
 */
const SNAPSHOT_ID = /^\d{8}T\d{6}Z(-\d+)?$/;

function snapshotId(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  sizeBytes: number;
  hasAttachments: boolean;
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly database: VesselDatabase) {}

  /** Timestamped snapshots live beside the database, not inside it. */
  private get backupsDir(): string {
    return path.join(this.database.dataDir, 'backups');
  }

  private get attachmentsDir(): string {
    return attachmentsDir(this.database.dataDir);
  }

  private dbPathIn(dir: string): string {
    return path.join(dir, 'vessel.sqlite');
  }

  /** Existing snapshots, newest first. */
  list(): SnapshotInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
    } catch (err: any) {
      if (err.code === 'ENOENT') return []; // nothing snapshotted yet
      throw err;
    }

    const out: SnapshotInfo[] = [];
    for (const entry of entries) {
      // Anything not ours is ignored rather than failing the whole
      // listing — an operator may well have left a stray file in here.
      if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name)) continue;
      const dir = path.join(this.backupsDir, entry.name);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(this.dbPathIn(dir)).size;
      } catch {
        // A directory with no database in it is a snapshot that failed
        // half way; listing it at zero bytes is more honest than hiding
        // it, since it still occupies the name.
      }
      out.push({
        id: entry.name,
        createdAt: this.parseId(entry.name),
        sizeBytes,
        hasAttachments: fs.existsSync(path.join(dir, 'attachments')),
      });
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  /**
   * A name nothing occupies yet.
   *
   * Ids are second-resolution, which reads well and matches the original,
   * but two snapshots can genuinely land in the same second — a restore
   * takes its safety snapshot immediately after whatever the operator
   * just did, and the nightly job can coincide with a manual one. VACUUM
   * INTO refuses to overwrite (rightly — a silent clobber would destroy
   * the very thing being kept), so the second one needs its own name.
   *
   * The suffix sorts correctly against a bare id: "…Z-2" orders after
   * "…Z", which is also the order they were taken in.
   */
  private freeSnapshotId(at: Date): string {
    const base = snapshotId(at);
    if (!fs.existsSync(path.join(this.backupsDir, base))) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!fs.existsSync(path.join(this.backupsDir, candidate))) return candidate;
    }
    throw new Error('Too many snapshots taken in the same second.');
  }

  /** "20260903T114500Z" (or "…Z-2") back to an ISO instant. */
  private parseId(id: string): string {
    return `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}.000Z`;
  }

  /**
   * Takes a snapshot now.
   *
   * VACUUM INTO rather than copying the file: it writes a consistent
   * database even while this one is being written to, which a plain copy
   * of a WAL-mode file does not.
   */
  snapshotNow(): SnapshotInfo {
    const now = new Date();
    const id = this.freeSnapshotId(now);
    const dir = path.join(this.backupsDir, id);
    fs.mkdirSync(dir, { recursive: true });

    const target = this.dbPathIn(dir);
    // Escaped for the SQL string literal; the path is ours, but a data
    // directory containing a quote would otherwise break the statement.
    this.database.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    // Attachments are content-addressed blobs on disk, so they are not in
    // the database and a database-only snapshot would restore reports
    // whose files had vanished.
    let hasAttachments = false;
    if (fs.existsSync(this.attachmentsDir)) {
      fs.cpSync(this.attachmentsDir, path.join(dir, 'attachments'), { recursive: true });
      hasAttachments = true;
    }

    const info: SnapshotInfo = {
      id,
      createdAt: now.toISOString(),
      sizeBytes: fs.statSync(target).size,
      hasAttachments,
    };
    this.logger.log(`Snapshot ${id} taken (${info.sizeBytes} bytes${hasAttachments ? ', with attachments' : ''}).`);
    return info;
  }

  /**
   * Replaces the live database with a snapshot.
   *
   * Closes the handle, swaps the files, reopens — the WAL and shared-memory
   * sidecars have to go too, or SQLite replays the old journal over the
   * restored file and quietly undoes the restore.
   */
  restore(id: string): SnapshotInfo {
    // Validated before it is ever joined to a path. This is the CWE-22
    // guard the original calls out by name.
    if (!SNAPSHOT_ID.test(id)) throw new Error('Not a valid snapshot id.');

    const dir = path.join(this.backupsDir, id);
    const source = this.dbPathIn(dir);
    if (!fs.existsSync(source)) throw new Error('That snapshot no longer exists.');

    const livePath = path.resolve(this.database.filePath);
    // Keep the pre-restore state under its own snapshot id rather than
    // deleting it: a restore is exactly when someone discovers they chose
    // the wrong snapshot, and without this there is nothing to go back to.
    const safety = this.snapshotNow();

    this.database.close();
    try {
      fs.copyFileSync(source, livePath);
      for (const sidecar of ['-wal', '-shm']) {
        const f = `${livePath}${sidecar}`;
        if (fs.existsSync(f)) fs.rmSync(f);
      }
      const restoredAttachments = path.join(dir, 'attachments');
      if (fs.existsSync(restoredAttachments)) {
        fs.rmSync(this.attachmentsDir, { recursive: true, force: true });
        fs.cpSync(restoredAttachments, this.attachmentsDir, { recursive: true });
      }
    } finally {
      // Always reopen, even if the swap threw part way. A node left with
      // a closed database is unusable and cannot be recovered without a
      // restart; reopening at least leaves it serving something.
      this.database.reopen();
    }

    this.logger.warn(`Restored snapshot ${id}. Pre-restore state saved as ${safety.id}.`);
    return { ...this.list().find((s) => s.id === id)!, id };
  }

  /** Deletes one snapshot. */
  remove(id: string): void {
    if (!SNAPSHOT_ID.test(id)) throw new Error('Not a valid snapshot id.');
    fs.rmSync(path.join(this.backupsDir, id), { recursive: true, force: true });
    this.logger.log(`Snapshot ${id} deleted.`);
  }

  /**
   * The nightly job — ports RunNightlySnapshot. A failure is logged and
   * swallowed: one missed snapshot must not take the reporting terminal
   * down with it.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  runNightly(): void {
    try {
      this.snapshotNow();
    } catch (err: any) {
      this.logger.error(`Nightly snapshot failed: ${err.message}`);
    }
  }
}
