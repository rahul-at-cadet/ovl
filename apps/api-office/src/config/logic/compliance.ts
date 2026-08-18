import { Scope, coversVessel } from './scope';

/** Ports ovl/office/compliance/{cadence,profiles,rulesev}.go. */

export const ALL_PROFILES = ['mrv', 'dcs', 'cii', 'voyageVerification'] as const;
export type RegulatoryProfile = (typeof ALL_PROFILES)[number];

export interface ProfileAssignment {
  scope: Scope;
  profiles: string[];
}

/**
 * Union semantics, not narrowest-scope-wins: a regulatory profile is a
 * yes/no legal reporting obligation — nothing lets a vessel-level toggle
 * turn OFF a fleet-wide obligation. Output order is fixed to ALL_PROFILES
 * order, not assignment order, for determinism.
 */
export function effectiveProfiles(
  assignments: ProfileAssignment[],
  vesselId: string,
  vesselGroups: string[],
): string[] {
  const active = new Set<string>();
  for (const a of assignments) {
    if (!coversVessel(a.scope, vesselId, vesselGroups)) continue;
    for (const p of a.profiles) active.add(p);
  }
  return ALL_PROFILES.filter((p) => active.has(p));
}

export const DEFAULT_MIN_REPORT_INTERVAL_HOURS = 24;
export const DEFAULT_MAX_GAP_HOURS = 12;

export interface CadenceRule {
  scope: Scope;
  minReportIntervalHours: number;
  maxGapHours: number;
}

function stricterCadence(a: CadenceRule, b: CadenceRule): CadenceRule {
  if (a.maxGapHours !== b.maxGapHours) return a.maxGapHours < b.maxGapHours ? a : b;
  return a.minReportIntervalHours <= b.minReportIntervalHours ? a : b;
}

/**
 * Vessel-scoped rule wins outright; else the most restrictive covering
 * group rule (smaller maxGapHours, tie-broken by smaller
 * minReportIntervalHours — a numeric threshold has no natural "union", so
 * strictest-wins is the safe default for a vessel in two groups); else
 * fleet-wide; else hardcoded defaults.
 */
export function effectiveCadence(
  rules: CadenceRule[],
  vesselId: string,
  vesselGroups: string[],
): CadenceRule {
  const vesselRule = rules.find((r) => r.scope.type === 'vessel' && r.scope.key === vesselId);
  if (vesselRule) return vesselRule;

  const groupRules = rules.filter(
    (r) => r.scope.type === 'group' && coversVessel(r.scope, vesselId, vesselGroups),
  );
  if (groupRules.length > 0) {
    return groupRules.reduce((best, r) => stricterCadence(best, r));
  }

  const fleetRule = rules.find((r) => r.scope.type === 'fleet');
  if (fleetRule) return fleetRule;

  return {
    scope: { type: 'fleet' },
    minReportIntervalHours: DEFAULT_MIN_REPORT_INTERVAL_HOURS,
    maxGapHours: DEFAULT_MAX_GAP_HOURS,
  };
}

export const OVERRIDABLE_RULE_IDS = [
  'plausibility.timeBucketSum',
  'plausibility.impliedSpeed',
  'plausibility.noDistanceStationary',
  'plausibility.positionRequired',
  'plausibility.positionConsistency',
  'continuity.timeChain',
  'continuity.robContinuity',
  'continuity.eventOrdering',
  'continuity.timestampUniqueness',
] as const;

export const HARD_RULE_IDS = ['plausibility.consumptionSchemeExclusivity'] as const;

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

export interface RuleSeverityAssignment {
  scope: Scope;
  severities: Record<string, string>;
}

/**
 * Resolved per rule ID (unlike cadence, which picks one winning rule
 * wholesale) — a vessel can have an explicit override for rule A while
 * inheriting rule B's override from fleet. A rule nobody overrides is
 * absent from the result map entirely (the caller/engine applies its own
 * hardcoded default), matching Go's EffectiveSeverities.
 */
export function effectiveSeverities(
  assignments: RuleSeverityAssignment[],
  vesselId: string,
  vesselGroups: string[],
): Record<string, string> {
  const vesselAssignment = assignments.find((a) => a.scope.type === 'vessel' && a.scope.key === vesselId);
  const fleetAssignment = assignments.find((a) => a.scope.type === 'fleet');
  const groupAssignments = assignments.filter(
    (a) => a.scope.type === 'group' && coversVessel(a.scope, vesselId, vesselGroups),
  );

  const result: Record<string, string> = {};
  for (const ruleId of OVERRIDABLE_RULE_IDS) {
    const vesselSev = vesselAssignment?.severities[ruleId];
    if (vesselSev !== undefined) {
      result[ruleId] = vesselSev;
      continue;
    }
    let strictestGroupSev: string | undefined;
    let bestRank = Infinity;
    for (const a of groupAssignments) {
      const sev = a.severities[ruleId];
      if (sev === undefined) continue;
      const rank = SEVERITY_RANK[sev] ?? 1;
      if (rank < bestRank) {
        bestRank = rank;
        strictestGroupSev = sev;
      }
    }
    if (strictestGroupSev !== undefined) {
      result[ruleId] = strictestGroupSev;
      continue;
    }
    const fleetSev = fleetAssignment?.severities[ruleId];
    if (fleetSev !== undefined) result[ruleId] = fleetSev;
  }
  return result;
}
