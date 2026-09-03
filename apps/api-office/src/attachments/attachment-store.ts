import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Content-addressed attachment store — ports ovl/pkg/attachmentstore, and
 * the shore-side mirror of apps/api-vessel/src/reports/attachment-store.ts.
 *
 * Files are named and deduplicated by sha256, sharded two hex characters
 * deep (git's object-store layout) so no directory holds more than a few
 * hundred entries. Content addressing is global rather than per-vessel on
 * purpose: identical bytes from any vessel resolve to one stored object.
 *
 * The two apps share no code, so this is kept deliberately in step with
 * the vessel's copy — the same arrangement password.ts and the DR crypto
 * already use. This one additionally accepts a file rather than a buffer,
 * because office assembles uploads from chunks on disk and must never
 * hold a whole attachment in memory.
 */
export class AttachmentStore {
  constructor(private readonly baseDir: string) {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  pathFor(hash: string): string {
    if (hash.length < 2) return path.join(this.baseDir, hash);
    return path.join(this.baseDir, hash.slice(0, 2), hash);
  }

  /**
   * Moves an already-assembled file into the store under `expectedHash`,
   * refusing it if the bytes do not hash to that name.
   *
   * The verification is the whole point: a chunked upload is assembled
   * from pieces that arrived separately, and the declared hash is the
   * only claim that they add up to the file the vessel meant to send. A
   * store that accepted whatever it was given would file corrupt
   * evidence under a name asserting it was intact, unrecoverably.
   */
  putFile(sourcePath: string, expectedHash: string): { stored: boolean } {
    const actual = this.hashFile(sourcePath);
    if (actual !== expectedHash) {
      throw new Error(`content hash mismatch: assembled ${actual}, expected ${expectedHash}`);
    }

    const dest = this.pathFor(expectedHash);
    if (fs.existsSync(dest)) return { stored: false }; // already held

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      // Same filesystem, so this is an atomic rename rather than a copy —
      // a reader only ever sees the complete file or no file at all.
      fs.renameSync(sourcePath, dest);
    } catch (err: any) {
      if (err.code !== 'EXDEV') throw err;
      // Staging on a different device than the store. Copy to a
      // neighbouring temp file first so the final step is still an
      // atomic rename within the destination directory.
      const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.copyFileSync(sourcePath, tmp);
      fs.renameSync(tmp, dest);
      fs.rmSync(sourcePath, { force: true });
    }
    return { stored: true };
  }

  /** Streamed rather than read whole: attachments can be large. */
  private hashFile(p: string): string {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 16);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  }

  /**
   * Whether content with this hash is present and intact.
   *
   * Re-hashes rather than trusting the filename. In a content-addressed
   * store the hash is the only integrity claim there is, so a truncated
   * file must read as absent — which makes the vessel send it again
   * instead of shore serving damaged evidence.
   */
  has(hash: string): boolean {
    const p = this.pathFor(hash);
    if (!fs.existsSync(p)) return false;
    try {
      return this.hashFile(p) === hash;
    } catch {
      return false;
    }
  }

  /** Absolute path for streaming a download, or null if not held. */
  resolve(hash: string): string | null {
    return this.has(hash) ? this.pathFor(hash) : null;
  }
}
