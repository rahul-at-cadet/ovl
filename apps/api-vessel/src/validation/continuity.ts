import { Finding, ValidationConfig, ValidationReport, configSeverity, fieldFloat } from './types';

export const RULE_TIME_CHAIN = 'continuity.timeChain';
export const RULE_ROB_CONTINUITY = 'continuity.robContinuity';
export const RULE_EVENT_ORDERING = 'continuity.eventOrdering';
export const RULE_TIMESTAMP_UNIQUENESS = 'continuity.timestampUniqueness';

// Ports ovl/pkg/validation/continuity.go's EvaluateTimeChain.
export function evaluateTimeChain(r: ValidationReport, prev: ValidationReport | null, cfg: ValidationConfig): Finding[] {
  if (!prev) return [];
  const tsp = fieldFloat(r, 'Time_Since_Previous_Report');
  if (tsp === undefined) return [];
  const actualHours = (r.eventTime.getTime() - prev.eventTime.getTime()) / (1000 * 60 * 60);
  if (Math.abs(tsp - actualHours) > cfg.timeChainToleranceHours) {
    return [
      {
        ruleId: RULE_TIME_CHAIN,
        severity: configSeverity(cfg, RULE_TIME_CHAIN, 'warning'),
        field: 'Time_Since_Previous_Report',
        message: `Time_Since_Previous_Report is ${tsp.toFixed(2)}h, but ${actualHours.toFixed(2)}h elapsed since the previous report`,
      },
    ];
  }
  return [];
}

// Ports EvaluateROBContinuity. Formula: ROB(n) = ROB(n-1) - consumption(n)
// + bunkered(n). Consumption comes from the CURRENT report, not the
// previous one. Either side missing the ROB field silently skips that
// series (not an error) — matches the original exactly.
export function evaluateRobContinuity(r: ValidationReport, prev: ValidationReport | null, cfg: ValidationConfig): Finding[] {
  if (!prev) return [];
  const findings: Finding[] = [];
  for (const s of cfg.robSeriesList) {
    const cur = fieldFloat(r, s.robField);
    const prior = fieldFloat(prev, s.robField);
    if (cur === undefined || prior === undefined) continue;

    let consumption = 0;
    for (const f of s.consumptionFields) {
      consumption += fieldFloat(r, f) ?? 0;
    }
    const bunkered = cfg.bunkeredAmounts[s.name] ?? 0;
    const expected = prior - consumption + bunkered;

    if (Math.abs(cur - expected) > cfg.robToleranceMt) {
      findings.push({
        ruleId: RULE_ROB_CONTINUITY,
        severity: configSeverity(cfg, RULE_ROB_CONTINUITY, 'warning'),
        field: s.robField,
        message: `${s.robField} is ${cur.toFixed(2)}, expected ${expected.toFixed(2)} (previous ${prior.toFixed(2)} - consumption ${consumption.toFixed(2)} + bunkered ${bunkered.toFixed(2)})`,
      });
    }
  }
  return findings;
}

// Ports EvaluateTimestampUniqueness. Bucket key is floor(unix seconds /
// 60) — minute resolution. All colliding reports are flagged, not just
// the later one. Input need not be pre-sorted.
export function evaluateTimestampUniqueness(chain: ValidationReport[], cfg: ValidationConfig): Map<string, Finding[]> {
  const byMinute = new Map<number, ValidationReport[]>();
  for (const r of chain) {
    const bucket = Math.floor(r.eventTime.getTime() / 1000 / 60);
    const list = byMinute.get(bucket);
    if (list) list.push(r);
    else byMinute.set(bucket, [r]);
  }

  const out = new Map<string, Finding[]>();
  for (const reports of byMinute.values()) {
    if (reports.length < 2) continue;
    for (const r of reports) {
      const minuteLabel = formatMinute(r.eventTime);
      const finding: Finding = {
        ruleId: RULE_TIMESTAMP_UNIQUENESS,
        severity: configSeverity(cfg, RULE_TIMESTAMP_UNIQUENESS, 'error'),
        message: `another report shares the same timestamp ${minuteLabel} at minute resolution`,
      };
      const existing = out.get(r.reportId);
      if (existing) existing.push(finding);
      else out.set(r.reportId, [finding]);
    }
  }
  return out;
}

function formatMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Ports EvaluateEventOrdering. Chain MUST be sorted by eventTime
// ascending before calling. lastStage is updated even when a finding
// fires, and a group's first-seen event never fires (starts at -1) — so
// a chain starting mid-sequence (e.g. "EndOfShifting" with no preceding
// "BeginOfShifting") is NOT flagged, only true repeats are.
export function evaluateEventOrdering(sortedChain: ValidationReport[], cfg: ValidationConfig): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const g of cfg.eventGroups) {
    const stageOf = (eventType: string): 0 | 1 | -1 => {
      if (g.stage0.includes(eventType)) return 0;
      if (g.stage1.includes(eventType)) return 1;
      return -1;
    };
    let lastStage: 0 | 1 | -1 = -1;
    for (const r of sortedChain) {
      const stage = stageOf(r.eventType);
      if (stage === -1) continue;
      if (lastStage === stage) {
        const finding: Finding = {
          ruleId: RULE_EVENT_ORDERING,
          severity: configSeverity(cfg, RULE_EVENT_ORDERING, 'warning'),
          message: `"${r.eventType}" cannot follow another event in the same "${g.name}" sequence without alternating`,
        };
        const existing = out.get(r.reportId);
        if (existing) existing.push(finding);
        else out.set(r.reportId, [finding]);
      }
      lastStage = stage;
    }
  }
  return out;
}
