import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AttachmentStore } from './attachment-store';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-att-'));
}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('AttachmentStore', () => {
  let dir: string;
  let store: AttachmentStore;
  beforeEach(() => {
    dir = tmpdir();
    store = new AttachmentStore(path.join(dir, 'objects'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const staged = (bytes: Buffer) => {
    const p = path.join(dir, `staged-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(p, bytes);
    return p;
  };

  it('stores a file under its hash and shards two characters deep', () => {
    const bytes = Buffer.from('evidence photo');
    const hash = sha(bytes);
    expect(store.putFile(staged(bytes), hash)).toEqual({ stored: true });
    expect(store.has(hash)).toBe(true);
    expect(store.pathFor(hash)).toContain(path.join(hash.slice(0, 2), hash));
  });

  it('refuses content that does not hash to the name it claims', () => {
    // The declared hash is the only claim that separately-arrived chunks
    // add up to the file the vessel meant to send. Accepting anything
    // else would file corrupt evidence under a name asserting it is
    // intact, unrecoverably.
    const bytes = Buffer.from('actual bytes');
    const lie = sha(Buffer.from('what the vessel claimed'));
    expect(() => store.putFile(staged(bytes), lie)).toThrow(/content hash mismatch/);
    expect(store.has(lie)).toBe(false);
  });

  it('deduplicates identical content', () => {
    const bytes = Buffer.from('same bytes from two vessels');
    const hash = sha(bytes);
    expect(store.putFile(staged(bytes), hash).stored).toBe(true);
    expect(store.putFile(staged(bytes), hash).stored).toBe(false);
  });

  it('reports a truncated file as absent rather than present', () => {
    // A store that trusted the filename would serve damaged evidence.
    // Reading as absent is what makes the vessel send it again.
    const bytes = Buffer.from('a complete attachment');
    const hash = sha(bytes);
    store.putFile(staged(bytes), hash);
    fs.writeFileSync(store.pathFor(hash), Buffer.from('trunc'));

    expect(store.has(hash)).toBe(false);
    expect(store.resolve(hash)).toBeNull();
  });

  it('hashes correctly across the streaming boundary', () => {
    // Read in 64 KiB blocks, so content larger than one block is where a
    // naive implementation would silently hash only the first part.
    const bytes = crypto.randomBytes(200 * 1024);
    const hash = sha(bytes);
    expect(store.putFile(staged(bytes), hash).stored).toBe(true);
    expect(store.has(hash)).toBe(true);
  });

  it('handles empty content', () => {
    const bytes = Buffer.alloc(0);
    const hash = sha(bytes);
    expect(store.putFile(staged(bytes), hash).stored).toBe(true);
    expect(store.has(hash)).toBe(true);
  });
});
