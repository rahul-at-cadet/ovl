import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

/**
 * The vessel's half of disaster-recovery encryption — ports
 * ovl/pkg/backupcrypto, and the mirror of
 * apps/api-office/src/vessels/logic/backup-crypto.ts.
 *
 * Uses `age-encryption` (typage), by the author of age and of the
 * `filippo.io/age` package the original wraps, so a bundle produced by
 * either implementation opens on the other. Office's copy carries the
 * golden-vector test that proves it against real Go output.
 *
 * The two apps share no code — office speaks Postgres, this one SQLite,
 * and neither depends on the other — so this file is kept deliberately
 * in step with office's, the same arrangement password.ts already uses.
 *
 * The asymmetry is the point: the keypair is minted here and only the
 * public half is ever sent to shore, so office can encrypt a bundle *to*
 * this vessel that office itself can never read. There is no encrypt()
 * here for the same reason there is no decrypt() in normal office use.
 */

export interface DrIdentity {
  /** age recipient string, `age1…` — sent to shore at enrollment. */
  publicKey: string;
  /** age identity string, `AGE-SECRET-KEY-1…` — never leaves this node. */
  privateKey: string;
}

export async function generateIdentity(): Promise<DrIdentity> {
  const privateKey = await generateX25519Identity();
  const publicKey = await identityToRecipient(privateKey);
  return { publicKey, privateKey };
}

/** Opens a bundle office encrypted to this vessel's public key. */
export async function decrypt(ciphertext: Uint8Array, identityPrivateKey: string): Promise<Uint8Array> {
  const d = new Decrypter();
  d.addIdentity(identityPrivateKey);
  return d.decrypt(ciphertext, 'uint8array');
}
