import { OvdField } from '../reports/schema-registry.service';
import { Finding, FieldEvents, FieldPolicy, ValidationReport, fieldIsEmpty } from './types';
import { policyStateForEvent } from './policy';

export const RULE_FIELD_REQUIRED = 'field.required';
export const RULE_FIELD_TYPE = 'field.type';
export const RULE_FIELD_MAX_LENGTH = 'field.maxLength';
export const RULE_FIELD_FORMAT = 'field.format';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

// Go's time.Parse("2006-01-02", s) round-trips through a real calendar —
// "2026-02-30" fails even though the regex shape matches. Date.UTC
// silently normalizes overflow (Feb 30 -> Mar 2), so the round-trip check
// below is what actually catches it.
function isValidCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  return isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isValidTimeString(s: string): boolean {
  const m = TIME_RE.exec(s);
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

// Ports ovl/pkg/validation/fieldrules.go's ParseEventTime — combines the
// schema's Date_UTC + Time_UTC fields (space-separated, matching
// dateTimeLayout "2006-01-02 15:04") into the report's EventTime.
export function parseEventTime(dateUTC: string, timeUTC: string): Date | null {
  if (!isValidDateString(dateUTC) || !isValidTimeString(timeUTC)) return null;
  const [y, mo, d] = dateUTC.split('-').map(Number);
  const [h, mi] = timeUTC.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

function checkFieldFormat(r: ValidationReport, f: OvdField): Finding[] {
  const v = r.fields[f.name];
  const label = f.label || f.name;
  const typeErr = (want: string): Finding[] => [
    { ruleId: RULE_FIELD_TYPE, severity: 'error', field: f.name, message: `${label} must be ${want}` },
  ];

  switch (f.type) {
    case 'text':
    case 'enum': {
      if (typeof v !== 'string') return typeErr('text');
      // Go's len() counts bytes, not runes/characters.
      if (f.maxLength != null && Buffer.byteLength(v, 'utf8') > f.maxLength) {
        return [
          {
            ruleId: RULE_FIELD_MAX_LENGTH,
            severity: 'error',
            field: f.name,
            message: `${label} exceeds maximum length of ${f.maxLength}`,
          },
        ];
      }
      return [];
    }
    case 'wholeNumber': {
      if (typeof v !== 'number') return typeErr('a whole number');
      if (!Number.isInteger(v)) {
        return [{ ruleId: RULE_FIELD_FORMAT, severity: 'error', field: f.name, message: `${label} must be a whole number` }];
      }
      return [];
    }
    case 'decimal': {
      if (typeof v !== 'number') return typeErr('a number');
      return [];
    }
    case 'boolean': {
      if (typeof v !== 'boolean') return typeErr('true or false');
      return [];
    }
    case 'date': {
      if (typeof v !== 'string') return typeErr('a date/time string');
      if (!isValidDateString(v)) {
        return [{ ruleId: RULE_FIELD_FORMAT, severity: 'error', field: f.name, message: `${label} does not match the expected format` }];
      }
      return [];
    }
    case 'time': {
      if (typeof v !== 'string') return typeErr('a date/time string');
      if (!isValidTimeString(v)) {
        return [{ ruleId: RULE_FIELD_FORMAT, severity: 'error', field: f.name, message: `${label} does not match the expected format` }];
      }
      return [];
    }
    case 'dateTime': {
      if (typeof v !== 'string') return typeErr('a date/time string');
      const parts = v.split(' ');
      if (parts.length !== 2 || !isValidDateString(parts[0]) || !isValidTimeString(parts[1])) {
        return [{ ruleId: RULE_FIELD_FORMAT, severity: 'error', field: f.name, message: `${label} does not match the expected format` }];
      }
      return [];
    }
    default:
      return [];
  }
}

// Ports ovl/pkg/validation/fieldrules.go's EvaluateFieldRules. Enum
// fields are NOT checked against their enum catalog — treated exactly
// like text — a documented gap in the original, not something to "fix"
// here since faithfulness to the ported behavior matters more than
// completeness for a rule the original itself never enforced.
export function evaluateFieldRules(
  r: ValidationReport,
  fields: OvdField[],
  policy: FieldPolicy,
  events: FieldEvents,
): Finding[] {
  const findings: Finding[] = [];
  for (const f of fields) {
    const state = policyStateForEvent(policy, f.name, f.schemaMandatory, f.relevance, events, r.eventType);
    if (state === 'hidden') continue;

    const empty = fieldIsEmpty(r, f.name);
    const label = f.label || f.name;
    if (state === 'schemaMandatory' || state === 'companyMandatory') {
      if (empty) {
        findings.push({ ruleId: RULE_FIELD_REQUIRED, severity: 'error', field: f.name, message: `${label} is required` });
      }
    } else if (state === 'recommended') {
      if (empty) {
        findings.push({ ruleId: RULE_FIELD_REQUIRED, severity: 'warning', field: f.name, message: `${label} is recommended but empty` });
      }
    }

    if (!empty) findings.push(...checkFieldFormat(r, f));
  }
  return findings;
}
