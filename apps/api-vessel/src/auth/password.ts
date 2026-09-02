import * as argon2 from 'argon2';

/**
 * Password hashing primitives — ports ovl/pkg/authcrypto/password.go.
 *
 * Exists as one module for the same reason the Go package does: the
 * primitive was previously spelled out at every call site, so the cost
 * parameters, the length bounds and the timing defence below could drift
 * apart between them (and had — no call site bounded input length, and
 * none performed a dummy verify).
 */

/** Matches the original's own floor. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * An explicit upper bound, not politeness: argon2 cost scales with input
 * length, so an unbounded password field is a cheap way to make the
 * server do unbounded work on an endpoint that is reachable before
 * authentication.
 */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Pinned rather than left to the library's defaults so the cost is a
 * property of this code and not of whichever node-argon2 version is
 * installed. m=64MiB, t=3, p=2 matches authcrypto's hashParams.
 *
 * Changing these does not invalidate existing hashes: argon2 encodes its
 * parameters in the PHC string, so verify() uses whatever the stored
 * hash was created with.
 */
// `raw` is pinned false rather than omitted so TypeScript selects
// hash()'s string overload — with a widened options type it resolves to
// the Buffer one instead.
const HASH_OPTIONS: argon2.HashOptions & { raw: false } = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 2,
  raw: false,
};

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const invalid = validatePassword(password);
  if (invalid) throw new Error(invalid);
  return argon2.hash(password, HASH_OPTIONS);
}

/**
 * Verifies without throwing on a malformed stored hash — a corrupt row
 * should fail the login, not 500 the endpoint.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  // Bounded before hashing, so an oversized input costs nothing.
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A hash of a throwaway value, used to spend the same CPU time on a
 * login for an account that does not exist as on one that does.
 *
 * Without it, "no such user" returns in microseconds while a real
 * username spends argon2's full deliberate cost — a difference large
 * enough to read over the network, which turns the login endpoint into a
 * username oracle. Computed once and memoised: the point is to match the
 * cost of a verify, and re-deriving it per request would only add load.
 */
let dummyHashPromise: Promise<string> | undefined;

export function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('dummy-password-for-timing-equalisation', HASH_OPTIONS);
  return dummyHashPromise;
}

/**
 * Spends a verify's worth of time against a throwaway hash. Call on
 * every path that rejects before reaching a real password check.
 */
export async function spendDummyVerify(password: string): Promise<void> {
  try {
    await argon2.verify(await dummyHash(), password);
  } catch {
    // The comparison is expected to fail; only its cost matters.
  }
}
