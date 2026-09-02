/**
 * IMO check-digit validation for inline form feedback — the same rule
 * api-office enforces (apps/api-office/src/vessels/logic/imo.ts, itself
 * a port of ovl/office/vessels/vessel.go's ValidateIMO).
 *
 * Duplicated rather than imported: this is a browser bundle and
 * api-office's src isn't a published workspace package, so there's no
 * import path that wouldn't drag server code into the client. The API
 * remains the authority — this copy exists only so a typo is caught
 * before the round trip, and both sides carry the same test vector
 * (9074729) to make drift visible.
 *
 * Returns null when valid, or a human-readable reason when not.
 *
 * On the vessel side this gates the setup wizard's Enroll button, which
 * only pre-empts the rejection office's edge.enroll would return anyway
 * — office validates every IMO it is given, on both the match and
 * create paths, so there is nothing an invalid number could enrol as.
 */
export function validateImo(imo: string): string | null {
  if (imo.length === 0) {
    return 'IMO number is required';
  }
  if (imo.length !== 7) {
    return `IMO number must be exactly 7 digits (this has ${imo.length})`;
  }

  const digits: number[] = [];
  for (const ch of imo) {
    if (ch < '0' || ch > '9') {
      return 'IMO number must contain digits only';
    }
    digits.push(Number(ch));
  }

  let sum = 0;
  for (let i = 0, weight = 7; i < 6; i++, weight--) {
    sum += digits[i] * weight;
  }

  const checkDigit = sum % 10;
  if (checkDigit !== digits[6]) {
    // Name the number this would have to be: the failure is almost
    // always a single mistyped or transposed digit, and "did you mean
    // 9074729?" is what actually resolves it. Not auto-corrected —
    // which digit is wrong is unknowable, and silently rewriting a
    // hull's identifier is worse than asking.
    return `Not a valid IMO number — the check digit should be ${checkDigit}, so this would need to be ${imo.slice(0, 6)}${checkDigit}. Please re-check the number.`;
  }

  return null;
}
