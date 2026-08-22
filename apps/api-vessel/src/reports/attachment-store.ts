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

  /** Writes buf to the store, returning its sha256 content hash. */
  put(buf: Buffer): string {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const dest = this.pathFor(hash);
    if (fs.existsSync(dest)) return hash; // already stored
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return hash;
  }

  /** Reads back the bytes stored under hash, or null if not found. */
  get(hash: string): Buffer | null {
    const p = this.pathFor(hash);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }
}
