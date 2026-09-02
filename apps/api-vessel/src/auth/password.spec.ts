import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  dummyHash,
  hashPassword,
  spendDummyVerify,
  validatePassword,
  verifyPassword,
} from './password';

// argon2 is deliberately slow (64 MiB, t=3), so these need more than
// Jest's 5s default.
jest.setTimeout(30_000);

describe('validatePassword', () => {
  it('enforces the minimum length', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least/);
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('enforces a maximum length', () => {
    // Not politeness — argon2's cost scales with input, so an unbounded
    // field is free work for an attacker on a pre-auth endpoint.
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most/);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    await expect(verifyPassword(hash, 'correct-horse-battery')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    await expect(verifyPassword(hash, 'wrong-horse-battery')).resolves.toBe(false);
  });

  it('pins the cost parameters into the stored hash', async () => {
    // The PHC string records the parameters used, which is both why
    // pinning them is safe for existing hashes and how we assert it.
    const hash = await hashPassword('correct-horse-battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=65536');
    expect(hash).toContain('t=3');
    expect(hash).toContain('p=2');
  });

  it('refuses to hash a password outside the bounds', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least/);
    await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(/at most/);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    // A damaged row should fail the login, not 500 the endpoint.
    await expect(verifyPassword('not-a-phc-string', 'anything')).resolves.toBe(false);
  });

  it('rejects an over-long candidate without hashing it', async () => {
    const hash = await hashPassword('correct-horse-battery');
    const started = Date.now();
    await expect(verifyPassword(hash, 'a'.repeat(MAX_PASSWORD_LENGTH + 1))).resolves.toBe(false);
    // Short-circuits on length, so this must not pay argon2's cost.
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe('dummyHash', () => {
  it('is memoised, so the timing defence does not add load per request', async () => {
    const a = await dummyHash();
    const b = await dummyHash();
    expect(a).toBe(b);
  });

  it('costs about as much to verify as a real hash', async () => {
    // The whole point: a login for a nonexistent user must not resolve
    // measurably faster than one for a real user. Warm both first so the
    // comparison is verify-vs-verify, not verify-vs-hash.
    const realHash = await hashPassword('correct-horse-battery');
    await dummyHash();

    const timeReal = async () => {
      const t = Date.now();
      await verifyPassword(realHash, 'wrong-password');
      return Date.now() - t;
    };
    const timeDummy = async () => {
      const t = Date.now();
      await spendDummyVerify('wrong-password');
      return Date.now() - t;
    };

    // Median of three, since a single sample is noisy on shared CI.
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[1];
    const real = median([await timeReal(), await timeReal(), await timeReal()]);
    const dummy = median([await timeDummy(), await timeDummy(), await timeDummy()]);

    // Both pay argon2's cost, so neither should be close to instant and
    // they should be the same order of magnitude. Generous bounds: this
    // asserts "no order-of-magnitude oracle", not a constant-time claim.
    expect(dummy).toBeGreaterThan(5);
    expect(real).toBeGreaterThan(5);
    const ratio = Math.max(real, dummy) / Math.max(1, Math.min(real, dummy));
    expect(ratio).toBeLessThan(5);
  });
});
