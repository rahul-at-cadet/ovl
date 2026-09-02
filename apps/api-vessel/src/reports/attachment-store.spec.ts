import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { AttachmentStore } from './attachment-store';

describe('AttachmentStore', () => {
  let dir: string;
  let store: AttachmentStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
    store = new AttachmentStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

  it('round-trips content and names it by its hash', () => {
    const buf = Buffer.from('bunker delivery note');
    const hash = store.put(buf);
    expect(hash).toBe(sha(buf));
    expect(store.get(hash)?.toString()).toBe('bunker delivery note');
  });

  it('shards two hex characters deep', () => {
    const buf = Buffer.from('x');
    const hash = store.put(buf);
    expect(fs.existsSync(path.join(dir, hash.slice(0, 2), hash))).toBe(true);
  });

  it('deduplicates identical content', () => {
    const buf = Buffer.from('same bytes');
    expect(store.put(buf)).toBe(store.put(buf));
    const shard = path.join(dir, sha(buf).slice(0, 2));
    expect(fs.readdirSync(shard)).toHaveLength(1);
  });

  it('leaves no temporary files behind', () => {
    // The write goes via a temp file; none should survive a successful
    // put, or the store slowly fills with debris.
    const hash = store.put(Buffer.from('payload'));
    const shard = path.join(dir, hash.slice(0, 2));
    expect(fs.readdirSync(shard).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('treats a truncated file as absent rather than serving it', () => {
    // The exact corruption the non-atomic write could produce: a partial
    // file sitting at the path that is its own content hash. Without the
    // read-side check this is served as though it were intact evidence.
    const buf = Buffer.from('a full attachment payload');
    const hash = store.put(buf);
    fs.writeFileSync(store.pathFor(hash), Buffer.from('a full attach'));

    expect(store.get(hash)).toBeNull();
    expect(store.has(hash)).toBe(false);
  });

  it('treats substituted content as absent', () => {
    const hash = store.put(Buffer.from('original'));
    fs.writeFileSync(store.pathFor(hash), Buffer.from('tampered-but-same-length'));
    expect(store.get(hash)).toBeNull();
  });

  it('reports a miss for content never stored', () => {
    expect(store.get(sha(Buffer.from('never stored')))).toBeNull();
    expect(store.has(sha(Buffer.from('never stored')))).toBe(false);
  });

  it('handles empty content', () => {
    const hash = store.put(Buffer.alloc(0));
    expect(store.get(hash)?.length).toBe(0);
    expect(store.has(hash)).toBe(true);
  });
});
