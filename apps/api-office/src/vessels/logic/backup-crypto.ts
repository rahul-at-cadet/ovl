import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

/**
 * Disaster-recovery bundle encryption — ports ovl/pkg/backupcrypto.
 *
 * Uses `age-encryption` (typage), which is by the author of age and of the
 * `filippo.io/age` package the original wraps. That matters more than
 * convenience here: a vessel still running the Go binary has to be able to
 * decrypt a bundle produced by this office, so the two sides must agree on
 * the wire format exactly rather than merely both being "X25519 +
 * ChaCha20-Poly1305".
 *
 * The keypair is generated on the vessel and only its public key travels to
 * shore (stored on enrollments.dr_public_key), so office can encrypt a
 * bundle *to* a vessel it can never itself decrypt. Decrypt exists here for
 * tests and for the vessel-side port; office never holds a private key.
 */

export interface DrIdentity {
  /** age recipient string, `age1…` — safe to store and transmit. */
  publicKey: string;
  /** age identity string, `AGE-SECRET-KEY-1…` — never leaves the vessel. */
  privateKey: string;
}

export async function generateIdentity(): Promise<DrIdentity> {
  const privateKey = await generateX25519Identity();
  const publicKey = await identityToRecipient(privateKey);
  return { publicKey, privateKey };
}

/** Encrypts to a recipient's public key. */
export async function encrypt(plaintext: Uint8Array, recipientPublicKey: string): Promise<Uint8Array> {
  if (!recipientPublicKey) {
    // A vessel enrolled before DR keys existed has no recipient, and
    // encrypting to nothing would silently produce a bundle nobody can
    // open. Callers surface this as "re-enrol this vessel first".
    throw new Error('backup-crypto: no DR public key for this vessel');
  }
  const e = new Encrypter();
  e.addRecipient(recipientPublicKey);
  return e.encrypt(plaintext);
}

/** Reverses encrypt() with the matching private key. */
export async function decrypt(ciphertext: Uint8Array, identityPrivateKey: string): Promise<Uint8Array> {
  const d = new Decrypter();
  d.addIdentity(identityPrivateKey);
  return d.decrypt(ciphertext, 'uint8array');
}
