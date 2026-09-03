import { decrypt, encrypt, generateIdentity } from './backup-crypto';

jest.setTimeout(30_000);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('generateIdentity', () => {
  it('produces an age keypair in the standard string forms', async () => {
    const id = await generateIdentity();
    // These exact prefixes are what the Go side parses, and what makes a
    // key recognisable in a log or a config file.
    expect(id.publicKey).toMatch(/^age1[0-9a-z]+$/);
    expect(id.privateKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
  });

  it('never repeats', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips a bundle', async () => {
    const id = await generateIdentity();
    const payload = JSON.stringify({ vesselId: 'v-1', reports: [{ reportId: 'r-1' }] });
    const out = await decrypt(await encrypt(enc(payload), id.publicKey), id.privateKey);
    expect(dec(out)).toBe(payload);
  });

  it('produces age-formatted ciphertext', async () => {
    const id = await generateIdentity();
    const ct = await encrypt(enc('x'), id.publicKey);
    // The binary age format starts with its version line; asserting it
    // catches a library swap that silently changes the wire format.
    expect(dec(ct.slice(0, 22))).toContain('age-encryption.org/v1');
  });

  it('cannot be opened by a different identity', async () => {
    const mine = await generateIdentity();
    const theirs = await generateIdentity();
    const ct = await encrypt(enc('secret'), mine.publicKey);
    await expect(decrypt(ct, theirs.privateKey)).rejects.toThrow();
  });

  it('rejects tampered ciphertext rather than returning garbage', async () => {
    const id = await generateIdentity();
    const ct = await encrypt(enc('secret payload'), id.publicKey);
    // Flip a byte in the body. ChaCha20-Poly1305 is authenticated, so this
    // must fail loudly — a DR bundle that decrypts to corrupted data would
    // be restored as though it were sound.
    const tampered = new Uint8Array(ct);
    tampered[tampered.length - 5] ^= 0xff;
    await expect(decrypt(tampered, id.privateKey)).rejects.toThrow();
  });

  it('refuses to encrypt when the vessel has no DR key', async () => {
    // Encrypting to an empty recipient would produce a bundle nobody can
    // ever open; failing here lets the caller say "re-enrol first".
    await expect(encrypt(enc('x'), '')).rejects.toThrow(/no DR public key/);
  });

  it('handles an empty and a large payload', async () => {
    const id = await generateIdentity();
    expect((await decrypt(await encrypt(new Uint8Array(0), id.publicKey), id.privateKey)).length).toBe(0);

    const big = enc('x'.repeat(1_000_000));
    const out = await decrypt(await encrypt(big, id.publicKey), id.privateKey);
    expect(out.length).toBe(big.length);
  });
});

/**
 * Cross-implementation compatibility.
 *
 * This is the reason typage was chosen over any other X25519 library: a
 * vessel still running the Go binary must be able to open a bundle this
 * office produced, and this office must be able to read one the vessel
 * encrypted to its own key. Both directions were verified live against
 * filippo.io/age, and the Go-produced ciphertext below is kept as a fixed
 * vector so the wire format cannot drift later without a test failing —
 * without needing a Go toolchain to run the suite.
 */
describe('interoperability with filippo.io/age', () => {
  // Encrypted by the Go implementation. Its private key is a throwaway
  // generated for this fixture and protects nothing.
  const GO_CIPHERTEXT_B64 =
    'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBndVkzMkxZci9DQ1doc044QWY1NVpJNmhITWtwV0xnaXRhZEZobzYwbnhzCkdPSlFaRVR1KzNGaVlqV3d5T2hKMFNYVDEwOHVIZ1pnaUR3QmRSQUxjRlEKLS0tIGdlM2xBdjVQYnpoSDEweUhYUlRxT2p0K1l5eFc5TC8rNnN5QmhUWnZtcW8KFOi//dSL9Kcd5qJkvIIPGTR+Bulpq31YOvtSOE4vgX/6EEjKMW71zRkJ5Jz+0MwJwjJdmVAcqt6LjR/o6X8pFBMxN69Ih248OQuy12+tBx4bbGWnYaHXrTDZD4Qqoa2mUIy8/Y4=';
  const GO_IDENTITY = 'AGE-SECRET-KEY-15T43T5GM4XJNT7PUHYK7Z0L2H7TREU8RG4HGT0A7TH4VXL90LDYQCUCA34';
  const GO_PLAINTEXT = '{"vesselId":"golden-vector","note":"produced by filippo.io/age (Go)"}';

  it('decrypts a bundle produced by the Go implementation', async () => {
    const ciphertext = new Uint8Array(Buffer.from(GO_CIPHERTEXT_B64, 'base64'));
    expect(dec(await decrypt(ciphertext, GO_IDENTITY))).toBe(GO_PLAINTEXT);
  });

  it('emits the same age v1 format Go parses', async () => {
    // The header a Go reader keys off. If a future library swap changed
    // this, the vessel would silently stop being able to open bundles.
    const id = await generateIdentity();
    const ours = dec(await encrypt(enc('x'), id.publicKey));
    const theirs = dec(new Uint8Array(Buffer.from(GO_CIPHERTEXT_B64, 'base64')));
    expect(ours.split('\n')[0]).toBe(theirs.split('\n')[0]);
    expect(ours).toMatch(/^age-encryption\.org\/v1\n-> X25519 /);
  });
});
