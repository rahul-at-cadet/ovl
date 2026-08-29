import { Finding, ValidationConfig, ValidationReport, configSeverity, fieldFloat, fieldIsEmpty, fieldString } from './types';

export const RULE_TIME_BUCKET_SUM = 'plausibility.timeBucketSum';
export const RULE_IMPLIED_SPEED = 'plausibility.impliedSpeed';
export const RULE_NO_DISTANCE_STATIONARY = 'plausibility.noDistanceStationary';
export const RULE_CONSUMPTION_SCHEME_EXCLUSIVE = 'plausibility.consumptionSchemeExclusivity';
export const RULE_POSITION_REQUIRED = 'plausibility.positionRequired';
export const RULE_POSITION_CONSISTENCY = 'plausibility.positionConsistency';

const TIME_BUCKET_FIELDS = [
  'Time_Elapsed_Sailing',
  'Time_Elapsed_Anchoring',
  'Time_Elapsed_DP',
  'Time_Elapsed_Ice',
  'Time_Elapsed_Maneuvering',
  'Time_Elapsed_Waiting',
  'Time_Elapsed_Loading_Unloading',
  'Time_Elapsed_Drifting',
];

// Ports ovl/pkg/validation/plausibility.go's timeBucketSum. Not "must sum
// to 24h" — must sum to whatever Time_Since_Previous_Report says.
function timeBucketSum(r: ValidationReport, cfg: ValidationConfig): Finding[] {
  const tsp = fieldFloat(r, 'Time_Since_Previous_Report');
  if (tsp === undefined) return [];
  let sum = 0;
  let anyBucket = false;
  for (const name of TIME_BUCKET_FIELDS) {
    const v = fieldFloat(r, name);
    if (v !== undefined) {
      sum += v;
      anyBucket = true;
    }
  }
  if (!anyBucket) return [];
  if (Math.abs(sum - tsp) > cfg.timeBucketToleranceHours) {
    return [
      {
        ruleId: RULE_TIME_BUCKET_SUM,
        severity: configSeverity(cfg, RULE_TIME_BUCKET_SUM, 'warning'),
        field: 'Time_Since_Previous_Report',
        message: `time elapsed buckets sum to ${sum.toFixed(2)}h, but Time_Since_Previous_Report is ${tsp.toFixed(2)}h`,
      },
    ];
  }
  return [];
}

// Ports impliedSpeed — denominator is Time_Elapsed_Sailing, NOT
// Time_Since_Previous_Report.
function impliedSpeed(r: ValidationReport, cfg: ValidationConfig): Finding[] {
  const distance = fieldFloat(r, 'Distance');
  const sailingHours = fieldFloat(r, 'Time_Elapsed_Sailing');
  if (distance === undefined || sailingHours === undefined || sailingHours <= 0) return [];
  const speed = distance / sailingHours;
  if (speed < cfg.impliedSpeedMinKn || speed > cfg.impliedSpeedMaxKn) {
    return [
      {
        ruleId: RULE_IMPLIED_SPEED,
        severity: configSeverity(cfg, RULE_IMPLIED_SPEED, 'warning'),
        field: 'Distance',
        message: `implied speed ${speed.toFixed(1)} kn is outside the plausible range ${cfg.impliedSpeedMinKn.toFixed(0)}-${cfg.impliedSpeedMaxKn.toFixed(0)} kn`,
      },
    ];
  }
  return [];
}

function noDistanceStationary(r: ValidationReport, cfg: ValidationConfig): Finding[] {
  const distance = fieldFloat(r, 'Distance');
  if (distance === undefined || distance <= 0) return [];

  let stationary = false;
  const tsp = fieldFloat(r, 'Time_Since_Previous_Report');
  if (tsp !== undefined) {
    const anchoring = fieldFloat(r, 'Time_Elapsed_Anchoring');
    if (anchoring !== undefined && tsp > 0 && anchoring >= tsp - cfg.timeBucketToleranceHours) {
      stationary = true;
    }
  }
  const mode = fieldString(r, 'Mode');
  if (mode === 'InPort') stationary = true;

  if (stationary) {
    return [
      {
        ruleId: RULE_NO_DISTANCE_STATIONARY,
        severity: configSeverity(cfg, RULE_NO_DISTANCE_STATIONARY, 'warning'),
        field: 'Distance',
        message: 'distance greater than 0 reported while moored or at anchor for the full period',
      },
    ];
  }
  return [];
}

// Ports consumptionSchemeExclusivity — a HARD rule, always SeverityError,
// never subject to cfg.severities override (matches the original exactly:
// cfg.severity() is never consulted here). The BDN-lookup half is dead in
// this port (no BunkerReportLookup wired), matching the original vessel
// side which also passes a nil lookup.
function consumptionSchemeExclusivity(r: ValidationReport, cfg: ValidationConfig): Finding[] {
  const fuelTypeReported = cfg.fuelTypeConsumptionFields.some((name) => !fieldIsEmpty(r, name));
  const bdnFields = cfg.bdnMarkerFields.filter((name) => !fieldIsEmpty(r, name));
  const bdnReported = bdnFields.length > 0;

  const findings: Finding[] = [];
  if (fuelTypeReported && bdnReported) {
    findings.push({
      ruleId: RULE_CONSUMPTION_SCHEME_EXCLUSIVE,
      severity: 'error',
      message: 'both fuel-type-based and BDN-based consumption are reported on the same event',
    });
  }
  return findings;
}

function positionRules(r: ValidationReport, cfg: ValidationConfig): Finding[] {
  const findings: Finding[] = [];
  const mode = fieldString(r, 'Mode');
  const atSeaMoving = mode === 'AtSea' || mode === 'Sailing';

  const latDeg = fieldFloat(r, 'Latitude_Degree');
  const latNS = fieldString(r, 'Latitude_North_South');
  const lonDeg = fieldFloat(r, 'Longitude_Degree');
  const lonEW = fieldString(r, 'Longitude_East_West');

  // A blank string is "not filled in", not "filled in with an invalid
  // value". The Go original (and this port before it) tested only for a
  // missing key, so a hemisphere stored as "" counted as *present* here
  // and as an invalid letter below — reporting `hemisphere must be "N" or
  // "S"` on a field the crew had simply never touched.
  const latNSMissing = fieldIsEmpty(r, 'Latitude_North_South');
  const lonEWMissing = fieldIsEmpty(r, 'Longitude_East_West');

  if (atSeaMoving && (latDeg === undefined || lonDeg === undefined || latNSMissing || lonEWMissing)) {
    findings.push({
      ruleId: RULE_POSITION_REQUIRED,
      severity: configSeverity(cfg, RULE_POSITION_REQUIRED, 'warning'),
      message: 'position is required when at sea and moving',
    });
  }

  const consistency = (field: string, message: string) => ({
    ruleId: RULE_POSITION_CONSISTENCY,
    severity: configSeverity(cfg, RULE_POSITION_CONSISTENCY, 'error' as const),
    field,
    message,
  });

  if (latDeg !== undefined && (latDeg < 0 || latDeg > 90)) {
    findings.push(consistency('Latitude_Degree', 'latitude degrees must be between 0 and 90'));
  }
  const latMin = fieldFloat(r, 'Latitude_Minutes');
  if (latMin !== undefined && (latMin < 0 || latMin >= 60)) {
    findings.push(consistency('Latitude_Minutes', 'latitude minutes must be between 0 and 60'));
  }
  if (!latNSMissing && latNS !== undefined && latNS !== 'N' && latNS !== 'S') {
    findings.push(consistency('Latitude_North_South', 'latitude hemisphere must be "N" or "S"'));
  }
  if (lonDeg !== undefined && (lonDeg < 0 || lonDeg > 180)) {
    findings.push(consistency('Longitude_Degree', 'longitude degrees must be between 0 and 180'));
  }
  const lonMin = fieldFloat(r, 'Longitude_Minutes');
  if (lonMin !== undefined && (lonMin < 0 || lonMin >= 60)) {
    findings.push(consistency('Longitude_Minutes', 'longitude minutes must be between 0 and 60'));
  }
  if (!lonEWMissing && lonEW !== undefined && lonEW !== 'E' && lonEW !== 'W') {
    findings.push(consistency('Longitude_East_West', 'longitude hemisphere must be "E" or "W"'));
  }

  return findings;
}

// Ports ovl/pkg/validation/plausibility.go's EvaluatePlausibilityRules.
// Order matters for output ordering (matches the Go source's call order).
//
// `isFieldHidden` makes this pass policy-aware, which the Go original is
// not. evaluateFieldRules already skips fields the active policy hides
// (see field-rules.ts's `if (state === 'hidden') continue`), but these
// plausibility rules used to run regardless, so a config bundle that hid
// a field could still raise an error against it — an error with no
// control on screen to clear it, leaving the report permanently
// unsubmittable. That is not hypothetical: hiding the Position section
// stranded reports on `latitude hemisphere must be "N" or "S"`, because
// Latitude_North_South only ever renders inside the compound widget owned
// by the (now hidden) Latitude_Degree field. Findings that name no field
// are always kept — they describe the report as a whole, not one input.
export function evaluatePlausibilityRules(
  r: ValidationReport,
  cfg: ValidationConfig,
  isFieldHidden: (fieldName: string) => boolean = () => false,
): Finding[] {
  const findings = [
    ...timeBucketSum(r, cfg),
    ...impliedSpeed(r, cfg),
    ...noDistanceStationary(r, cfg),
    ...consumptionSchemeExclusivity(r, cfg),
    ...positionRules(r, cfg),
  ];
  return findings.filter((f) => !f.field || !isFieldHidden(f.field));
}
