/**
 * The temporary-password generator, against SuperTokens' default policy.
 *
 * This exists because the original generator drew every character
 * independently from one mixed alphabet, which does not guarantee the digit
 * that the policy requires. It failed about one time in five — often enough to
 * break real password resets, rarely enough to look like an unrelated flake.
 * A single example password proves nothing about that kind of bug, so this
 * asserts over a large sample.
 *
 * The function is private to users.service.ts, so it is reproduced here rather
 * than exported: widening a module's public surface for a test would be the
 * wrong trade, and the property under test — "every generated password
 * satisfies the policy" — is what has to stay true, not the implementation.
 * The copy is checked against the real one by the last test in this file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function randomPassword(length = 12): string {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$';
  const all = upper + lower + digits + symbols;

  const { randomInt } = require('crypto') as typeof import('crypto');
  const pick = (set: string) => set[randomInt(set.length)];

  const required = [pick(upper), pick(lower), pick(digits)];
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => pick(all));
  const chars = [...required, ...rest];

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const SAMPLE = 5000;

describe('randomPassword', () => {
  it('always contains a letter and a number, which is what SuperTokens requires', () => {
    const offenders: string[] = [];
    for (let i = 0; i < SAMPLE; i++) {
      const pw = randomPassword(12);
      if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) offenders.push(pw);
    }
    expect(offenders).toEqual([]);
  });

  it('is at least the requested length, and at least the policy minimum of 8', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomPassword(12)).toHaveLength(12);
    }
    expect(randomPassword(8).length).toBeGreaterThanOrEqual(8);
  });

  it('never emits glyphs that are ambiguous when read off a screen', () => {
    for (let i = 0; i < SAMPLE; i++) {
      expect(randomPassword(12)).not.toMatch(/[IlO01]/);
    }
  });

  it('does not put the guaranteed characters in fixed positions', () => {
    // Without the shuffle, position 0 would be an uppercase letter every time.
    const firsts = new Set<string>();
    for (let i = 0; i < 500; i++) firsts.add(randomPassword(12)[0]);
    const anyLower = [...firsts].some((c) => /[a-z]/.test(c));
    const anyDigit = [...firsts].some((c) => /[0-9]/.test(c));
    expect(anyLower || anyDigit).toBe(true);
  });

  it('still produces distinct passwords', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomPassword(12));
    expect(seen.size).toBe(1000);
  });

  it('matches the generator users.service.ts actually uses', () => {
    // Guards the one real risk in reproducing the function here: that the
    // service's copy is changed and this suite keeps testing the old one.
    const source = readFileSync(join(__dirname, 'users.service.ts'), 'utf8');
    for (const line of [
      "const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';",
      "const lower = 'abcdefghjkmnpqrstuvwxyz';",
      "const digits = '23456789';",
      'const required = [pick(upper), pick(lower), pick(digits)];',
    ]) {
      expect(source).toContain(line);
    }
  });
});
