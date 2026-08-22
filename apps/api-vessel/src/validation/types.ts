// Ports ovl/pkg/validation/finding.go — the shared vocabulary every rule
// class (field rules, plausibility, continuity, cascade) speaks. Findings
// are never persisted: they're recomputed on every check/validate call so
// they can never drift from the report's current field values (see
// ReportsService.checkReport's own comment).
export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  field?: string;
  message: string;
}

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

// Ports ovl/pkg/validation/report.go's Report — the engine's own view of
// a report, decoupled from the Drizzle row shape. `fields` values are
// exactly `number | string | boolean | null | undefined` — no coercion
// helpers, since Go's Float()/String()/Bool() only return ok=true for an
// exact type match (a numeric string is NOT a number here), and several
// rules below rely on that strictness to decide whether to fire at all.
export interface ValidationReport {
  reportId: string;
  versionNo: number;
  schemaName: string;
  eventType: string;
  eventTime: Date;
  fields: Record<string, unknown>;
}

export function fieldIsEmpty(r: ValidationReport, name: string): boolean {
  const v = r.fields[name];
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v === '';
  return false;
}

export function fieldFloat(r: ValidationReport, name: string): number | undefined {
  const v = r.fields[name];
  return typeof v === 'number' ? v : undefined;
}

export function fieldString(r: ValidationReport, name: string): string | undefined {
  const v = r.fields[name];
  return typeof v === 'string' ? v : undefined;
}

export function fieldBool(r: ValidationReport, name: string): boolean | undefined {
  const v = r.fields[name];
  return typeof v === 'boolean' ? v : undefined;
}

// Ports ovl/pkg/validation/config.go
export interface RobSeries {
  name: string;
  robField: string;
  consumptionFields: string[];
}

export interface AlternatingGroup {
  name: string;
  stage0: string[];
  stage1: string[];
}

export interface ValidationConfig {
  timeBucketToleranceHours: number;
  impliedSpeedMinKn: number;
  impliedSpeedMaxKn: number;
  timeChainToleranceHours: number;
  robToleranceMt: number;
  robSeriesList: RobSeries[];
  bunkeredAmounts: Record<string, number>;
  fuelTypeConsumptionFields: string[];
  bdnMarkerFields: string[];
  eventGroups: AlternatingGroup[];
  severities: Record<string, Severity>;
}

export function configSeverity(cfg: ValidationConfig, ruleId: string, deflt: Severity): Severity {
  return cfg.severities[ruleId] ?? deflt;
}

// Ports ovl/pkg/validation/policy.go
export type FieldPolicyState = 'hidden' | 'optional' | 'recommended' | 'companyMandatory' | 'schemaMandatory';

export type FieldPolicy = Record<string, FieldPolicyState>;
export type FieldEvents = Record<string, string[]>;

export const ALL_EVENTS = '*';

export function eventsAppliesTo(events: FieldEvents, fieldName: string, eventType: string): boolean {
  if (!eventType) return true;
  const list = events[fieldName];
  if (!list || list.length === 0) return true;
  return list.some((ev) => ev === ALL_EVENTS || ev === eventType);
}
