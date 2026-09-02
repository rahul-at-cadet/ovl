import {
  canonicalizeCode,
  formatCode,
  generateEnrollmentCode,
  isRedeemable,
} from './enrollment';

describe('generateEnrollmentCode', () => {
  it('produces a grouped base32 code of the expected shape', () => {
    // 10 random bytes -> 16 base32 characters -> four groups of four.
    expect(generateEnrollmentCode()).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  });

  it('never emits a digit that collides with a letter in the alphabet', () => {
    // Standard base32 (matching the Go original) is A–Z plus 2–7, so the
    // digits most easily confused with letters when read off paper —
    // 0/O, 1/I, 8/B, 9/g — cannot appear. The letters O, I and L can
    // still occur; the alphabet is not Crockford's, and canonicalizeCode
    // deliberately does not fold them, since doing so would accept codes
    // that were never issued.
    const joined = Array.from({ length: 40 }, generateEnrollmentCode).join('');
    expect(joined).not.toMatch(/[0189]/);
    expect(joined.replace(/-/g, '')).toMatch(/^[A-Z2-7]+$/);
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 200 }, generateEnrollmentCode));
    expect(codes.size).toBe(200);
  });
});

describe('canonicalizeCode', () => {
  it('accepts the variations a human actually types', () => {
    const canonical = 'ABCD2345EFGH6789';
    // As printed, lowercased, spaced instead of dashed, and run together
    // — all the same code.
    expect(canonicalizeCode('ABCD-2345-EFGH-6789')).toBe(canonical);
    expect(canonicalizeCode('abcd-2345-efgh-6789')).toBe(canonical);
    expect(canonicalizeCode('ABCD 2345 EFGH 6789')).toBe(canonical);
    expect(canonicalizeCode('  abcd2345efgh6789 ')).toBe(canonical);
  });

  it('is idempotent, so re-hashing a stored code is stable', () => {
    const once = canonicalizeCode('abcd-2345');
    expect(canonicalizeCode(once)).toBe(once);
  });

  it('round-trips through the display form', () => {
    const code = generateEnrollmentCode();
    expect(formatCode(canonicalizeCode(code))).toBe(code);
  });
});

describe('isRedeemable', () => {
  it('only accepts an issued enrollment that still holds a hash', () => {
    expect(isRedeemable('issued', 'hash')).toBe(true);
  });

  it('rejects every other state', () => {
    expect(isRedeemable('enrolled', 'hash')).toBe(false);
    expect(isRedeemable('revoked', 'hash')).toBe(false);
  });

  it('rejects a cleared hash even while the state still says issued', () => {
    // Revoke and redeem both clear the hash as well as moving the state.
    // This guards the case where only one of the two was written.
    expect(isRedeemable('issued', '')).toBe(false);
    expect(isRedeemable('issued', null)).toBe(false);
  });
});
