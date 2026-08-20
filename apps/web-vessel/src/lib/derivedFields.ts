// Ports ovl/web/vessel/src/screens/report-form/derivedFields.ts's two
// classes of live-computable fields that need no backend data beyond
// what's already on this form/report — a pure function of one sibling
// field (compass sector, Beaufort force), and one anchored to the
// current report's own eventTime vs. the previous submitted report's.
//
// Deliberately NOT ported: ROB continuity (ROB(n) = ROB(n-1) -
// consumption(n)). That needs the previous submitted report's own ROB
// field values as a base, which nothing in this port's schema/report
// APIs currently exposes — porting it faithfully would mean adding
// that server-side first rather than approximating it client-side.

// Vessel-relative compass sector (1-8), confirmed against the actual DNV
// reference diagram — sector 1 is centered on 0° (dead ahead/bow) and
// sectors run clockwise in 45° steps, each spanning ±22.5° of its
// center.
export function degreeToCompassSector(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  return (Math.floor((norm + 22.5) / 45) % 8) + 1;
}

// Standard WMO Beaufort scale, upper bound in knots for force 0-11
// (anything at or above the last bound is force 12).
const BEAUFORT_KN_UPPER = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];

export function knotsToBeaufort(kn: number): number {
  for (let force = 0; force < BEAUFORT_KN_UPPER.length; force++) {
    if (kn < BEAUFORT_KN_UPPER[force]) return force;
  }
  return 12;
}

interface DerivedFieldSpec {
  source: string;
  formulaLabel: (sourceValue: number) => string;
  compute: (sourceValue: number) => number;
}

// Wind's pair (enter relative wind course + speed, derive sector +
// Beaufort force); Sea state/Swell/Current's compass-sector fields get
// identical treatment since they share the exact same *_Dir/*_Dir_Degree
// relationship and DNV sector convention.
export const DERIVED_FIELDS: Record<string, DerivedFieldSpec> = {
  Wind_Dir: {
    source: 'Wind_Dir_Degree',
    formulaLabel: (v) => `Sector for relative wind direction ${Math.round(v)}°`,
    compute: degreeToCompassSector,
  },
  Wind_Force_Bft: {
    source: 'Wind_Force_Kn',
    formulaLabel: (v) => `Beaufort force for relative wind speed ${v} kn`,
    compute: knotsToBeaufort,
  },
  Sea_state_Dir: {
    source: 'Sea_state_Dir_Degree',
    formulaLabel: (v) => `Sector for sea state direction ${Math.round(v)}°`,
    compute: degreeToCompassSector,
  },
  Swell_Dir: {
    source: 'Swell_Dir_Degree',
    formulaLabel: (v) => `Sector for swell direction ${Math.round(v)}°`,
    compute: degreeToCompassSector,
  },
  Current_Dir: {
    source: 'Current_Dir_Degree',
    formulaLabel: (v) => `Sector for current direction ${Math.round(v)}°`,
    compute: degreeToCompassSector,
  },
};

function asNumber(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface DerivedResult {
  value: string;
  formula: string;
}

// Recomputes every live-derivable field from its source field's current
// value. A derived field with no valid (or not-yet-entered) source is
// left out entirely — no phantom zero.
export function computeDerivedValues(values: Record<string, unknown>): Record<string, DerivedResult> {
  const out: Record<string, DerivedResult> = {};
  for (const [name, spec] of Object.entries(DERIVED_FIELDS)) {
    const sourceValue = asNumber(values[spec.source]);
    if (sourceValue === null) continue;
    out[name] = { value: String(spec.compute(sourceValue)), formula: spec.formulaLabel(sourceValue) };
  }
  return out;
}

export function computeTimeSincePreviousReport(
  eventTimeIso: string | undefined,
  lastReportEventTimeIso: string | undefined,
): DerivedResult | undefined {
  if (!eventTimeIso || !lastReportEventTimeIso) return undefined;
  const eventTime = new Date(eventTimeIso).getTime();
  const lastReportEventTime = new Date(lastReportEventTimeIso).getTime();
  if (!Number.isFinite(eventTime) || !Number.isFinite(lastReportEventTime)) return undefined;
  const hours = (eventTime - lastReportEventTime) / 3_600_000;
  return {
    value: String(Math.round(hours * 100) / 100),
    formula: `Elapsed since the previous report at ${new Date(lastReportEventTime).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  };
}
