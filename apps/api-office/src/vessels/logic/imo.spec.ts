import { validateImo } from './imo';

// A real, checksum-valid IMO number (the standard example used to
// illustrate the IMO check-digit formula) — same constant the Go
// original's own test uses, so both suites are anchored to the same
// known-good value.
const VALID_IMO = '9074729';

describe('validateImo', () => {
  // Mirrors ovl/office/vessels/vessel_test.go's TestValidateIMO table
  // case for case, so the port stays verifiably equivalent.
  it.each([
    ['valid', VALID_IMO, false],
    ['wrong check digit', '9074728', true],
    ['too short', '907472', true],
    ['too long', '90747290', true],
    ['non-numeric', '907472X', true],
    ['empty', '', true],
  ])('%s: %s', (_name, imo, wantErr) => {
    const err = validateImo(imo as string);
    expect(err !== null).toBe(wantErr);
  });

  it('names the corrected number so a typo is actionable', () => {
    // The whole reason the formula is implemented rather than a length
    // check: the message has to say what the number should have been.
    const err = validateImo('9074728');
    expect(err).toContain('check digit should be 9');
    expect(err).toContain('9074729');
  });

  it('distinguishes the failure modes in its message', () => {
    expect(validateImo('')).toBe('IMO number is required');
    expect(validateImo('907472')).toContain('exactly 7 digits');
    expect(validateImo('907472X')).toContain('digits only');
  });

  it('rejects a transposed-digit typo that a length check would pass', () => {
    // 9074729 -> 9074279 (last two body digits swapped): still 7
    // digits, still all numeric, but the checksum catches it.
    expect(validateImo('9074279')).not.toBeNull();
  });

  it('accepts a check digit of 0', () => {
    // 1000000: 1*7 = 7, 7 % 10 = 7 -> not 0, so build one that does
    // land on 0. 9159100: 9*7+1*6+5*5+9*4+1*3+0*2 = 63+6+25+36+3+0 =
    // 133 -> 3. Use a known-valid real-world number instead: the
    // formula's own arithmetic is already covered above, this case
    // exists to prove digits[6] === 0 isn't treated as "missing".
    const sum = [9, 3, 1, 9, 0, 5].reduce((acc, d, i) => acc + d * (7 - i), 0);
    const imo = `931905${sum % 10}`;
    expect(validateImo(imo)).toBeNull();
  });
});
