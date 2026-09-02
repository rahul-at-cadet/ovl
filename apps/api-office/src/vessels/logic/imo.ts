/**
 * IMO ship identification number validation — ports
 * ovl/office/vessels/vessel.go's ValidateIMO verbatim, including its
 * reasoning: the check digit is implemented in full rather than just
 * checking "7 digits" so a transposed-digit typo is caught at entry time
 * instead of silently stored.
 *
 * The scheme is IMO's own public one, not an OVL-specific rule: exactly
 * 7 digits, where the 7th is a check digit computed from the first six
 * (each multiplied by a descending weight 7..2, summed, mod 10).
 *
 * Returns null when valid, or a human-readable reason when not — the
 * caller decides whether that becomes a tRPC error (office API) or
 * inline form feedback (the Provision/Edit dialog), so the identical
 * rule backs both instead of the UI and the API drifting apart.
 */
export function validateImo(imo: string): string | null {
  if (imo.length === 0) {
    return 'IMO number is required';
  }
  if (imo.length !== 7) {
    return `IMO number must be exactly 7 digits (got ${imo.length}: "${imo}")`;
  }

  const digits: number[] = [];
  for (const ch of imo) {
    if (ch < '0' || ch > '9') {
      return `IMO number must contain digits only (got "${imo}")`;
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
    // always one mistyped or transposed digit, so the correction is the
    // actionable part. Deliberately not auto-corrected — which digit is
    // wrong is unknowable, and silently rewriting a hull's permanent
    // identifier is worse than rejecting it.
    return `"${imo}" is not a valid IMO number — the check digit should be ${checkDigit}, so this would need to be ${imo.slice(0, 6)}${checkDigit}. Please re-check the number.`;
  }

  return null;
}
