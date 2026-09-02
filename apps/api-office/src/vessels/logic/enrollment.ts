import * as crypto from 'crypto';

/**
 * Vessel enrollment — ports ovl/office/enrollment/enrollment.go.
 *
 * A vessel is enrolled by redeeming a one-time code that office issued
 * for one specific vessel. The code is the identity: it is globally
 * unique and self-identifying, so the vessel sends only the code and
 * office resolves which vessel that is. That is what lets the setup
 * wizard stop asking a human to type a name and IMO — the previous flow
 * matched on IMO alone, which meant any holder of any fleet-wide
 * provisioning key could claim to be any vessel simply by typing its
 * number.
 */

/** Where one vessel's enrollment stands. */
export type EnrollmentState = 'issued' | 'enrolled' | 'revoked';

/**
 * Base32 (A–Z, 2–7), grouped in fours — matching authcrypto.RandomToken.
 * The alphabet and grouping matter because this is read aloud off a
 * printed sheet and typed in on a ship's bridge: no lowercase to
 * mis-shift, and no 0/1/8/9 to confuse with O/I/B/g.
 *
 * 10 bytes is 80 bits of entropy, which is what the original issues.
 */
const CODE_BYTES = 10;

export function generateEnrollmentCode(): string {
  // Node ships no base32 encoder, so the alphabet is applied directly to
  // the random bytes below rather than via Buffer.toString.
  return formatCode(toBase32(crypto.randomBytes(CODE_BYTES)));
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Reduces a code to the form that is hashed and compared.
 *
 * A deliberate divergence from the Go original, which hashes the
 * grouped string verbatim and so rejects the same code typed without
 * dashes or in lowercase. The code exists to be transcribed by hand
 * from paper, where exactly those two variations are what people
 * actually type; treating them as wrong codes would send an operator
 * hunting a nonexistent problem. Grouping is presentation, not secret
 * material, so canonicalising loses no entropy.
 */
export function canonicalizeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Formats a canonical code back into its grouped display form. */
export function formatCode(code: string): string {
  return canonicalizeCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Whether an enrollment in this state, holding this code hash, is still
 * redeemable. Revoke and redeem both *clear* the hash rather than only
 * moving the state flag, so a cleared hash is itself disqualifying even
 * if a caller forgets to check state first.
 */
export function isRedeemable(state: EnrollmentState, codeHash: string | null): boolean {
  return state === 'issued' && !!codeHash;
}
