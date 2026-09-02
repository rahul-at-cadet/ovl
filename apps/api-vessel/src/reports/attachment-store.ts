import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Ports ovl/pkg/attachmentstore — a content-addressed filesystem store:
 * files are named and deduplicated by sha256, sharded two hex characters
 * deep (git's object-store layout) so a base directory never holds more
 * than a few hundred entries per subdirectory. Storing the same content
 * twice is a no-op the second time since the destination path IS the
 * hash — automatic deduplication.
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
   * Writes buf to the store, returning its sha256 content hash.
   *
   * Written to a temporary file and renamed into place, matching the
   * original's Put. The previous direct writeFileSync was not atomic: a
   * crash or a full disk mid-write left a truncated file sitting at the
   * path that *is* its content hash, and every later call would then
   * find it with existsSync and report it as already stored. That is
   * silent corruption of an evidence file, and it is unrecoverable
   * because nothing ever re-checks the bytes against the name.
   *
   * rename(2) within one filesystem is atomic, so a reader only ever
   * sees the complete file or no file at all.
   */
  put(buf: Buffer): string {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const dest = this.pathFor(hash);
    if (fs.existsSync(dest)) return hash; // already stored

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Same directory as the destination, so the rename cannot cross a
    // filesystem boundary and fall back to a non-atomic copy.
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Nothing useful to do if the temp file is already gone.
      }
      throw e;
    }
    return hash;
  }

  /**
   * Reads back the bytes stored under hash, or null if not found.
   *
   * Verifies the content against the name it was filed under. In a
   * content-addressed store the hash is the only integrity claim there
   * is, so checking it converts a silently-corrupt file into a miss the
   * caller can handle — which is the difference between a report showing
   * damaged evidence and it showing none.
   */
  get(hash: string): Buffer | null {
    const p = this.pathFor(hash);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== hash) return null;
    return buf;
  }

  /** Whether content with this hash is present and intact. */
  has(hash: string): boolean {
    return this.get(hash) !== null;
  }
}
