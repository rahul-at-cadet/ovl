/**
 * Continuity rules (architecture 8.3) — the subset of plausibility rules
 * that span consecutive reports in a vessel+schema's chain and drive
 * cascade revalidation. Ports ovl/pkg/validation's continuity.go and
 * cascade.go's Revalidate near-verbatim, staying schema-agnostic the
 * same way: the engine just iterates whatever ROBSeriesList/EventGroups
 * a Config carries.
 */

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

export const RULE_TIME_CHAIN = 'continuity.timeChain';
export const RULE_ROB_CONTINUITY = 'continuity.robContinuity';
export const RULE_EVENT_ORDERING = 'continuity.eventOrdering';
export const RULE_TIMESTAMP_UNIQUENESS = 'continuity.timestampUniqueness';

/** The minimal, schema-driven view of a report version the rule engine needs. */
export interface ContinuityReport {
  reportId: string;
  versionNo: number;
  schemaName: string;
  eventType: string;
  eventTime: Date;
  fields: Record<string, unknown>;
}

function getFloat(r: ContinuityReport, name: string): number | undefined {
  const v = r.fields[name];
  return typeof v === 'number' ? v : undefined;
}

export interface ROBSeries {
  name: string;
  robField: string;
  consumptionFields: string[];
}

export interface AlternatingGroup {
  name: string;
  stage0: string[];
  stage1: string[];
}

export function defaultEventGroups(): AlternatingGroup[] {
  return [
    { name: 'arrivalDeparture', stage0: ['Arrival', 'ArrivalSTS'], stage1: ['Departure', 'DepartureSTS'] },
    { name: 'seaPassage', stage0: ['BOSP', 'BeginOfSeaPassage', 'FAOP', 'FullAheadOnPassage'], stage1: ['EOSP', 'EndOfSeaPassage'] },
    { name: 'shifting', stage0: ['BeginOfShifting'], stage1: ['EndOfShifting'] },
    { name: 'canalPassage', stage0: ['Begin canal passage'], stage1: ['End canal passage'] },
    { name: 'anchoringDrifting', stage0: ['Begin Anchoring/Drifting'], stage1: ['End Anchoring/Drifting'] },
    { name: 'fuelChangeOver', stage0: ['Begin fuel change over'], stage1: ['End fuel change over'] },
    { name: 'deviation', stage0: ['Begin of deviation'], stage1: ['End of deviation'] },
    { name: 'specialArea', stage0: ['Entering special area'], stage1: ['Leaving special area'] },
    { name: 'offhire', stage0: ['Beginofoffhire'], stage1: ['Endofoffhire'] },
  ];
}

export interface ContinuityConfig {
  timeChainToleranceHours: number;
  robToleranceMt: number;
  robSeriesList: ROBSeries[];
  bunkeredAmounts: Record<string, number>;
  eventGroups: AlternatingGroup[];
  severities: Record<string, Severity>;
}

export function defaultConfig(): ContinuityConfig {
  return {
    timeChainToleranceHours: 0.1,
    robToleranceMt: 0.5,
    robSeriesList: [],
    bunkeredAmounts: {},
    eventGroups: defaultEventGroups(),
    severities: {},
  };
}

// The single, hand-curated ROB continuity chain for log-abstract — see
// pkg/validation/config.go's LogAbstractConfig doc comment for why this
// covers all ten fuel-type ROB tracks (not just HFO) and every consumer
// category that draws each one down (Main Engine, Auxiliary Engine,
// Boiler, and — for HFO/LFO/MGO/MDO only — Inert Gas Generator and Cargo
// Heating), not just ME_Consumption_<fuel> alone.
const LOG_ABSTRACT_FUEL_TYPES: { suffix: string; robField: string; extraConsumers: boolean }[] = [
  { suffix: 'HFO', robField: 'HFO_ROB', extraConsumers: true },
  { suffix: 'LFO', robField: 'LFO_ROB', extraConsumers: true },
  { suffix: 'MGO', robField: 'MGO_ROB', extraConsumers: true },
  { suffix: 'MDO', robField: 'MDO_ROB', extraConsumers: true },
  { suffix: 'LPGP', robField: 'LPGP_ROB', extraConsumers: false },
  { suffix: 'LPGB', robField: 'LPGB_ROB', extraConsumers: false },
  { suffix: 'LNG', robField: 'LNG_ROB', extraConsumers: false },
  { suffix: 'M', robField: 'Methanol_ROB', extraConsumers: false },
  { suffix: 'E', robField: 'Ethanol_ROB', extraConsumers: false },
  { suffix: 'O', robField: 'O_ROB', extraConsumers: false },
];

export function logAbstractConfig(): ContinuityConfig {
  const cfg = defaultConfig();
  cfg.robSeriesList = LOG_ABSTRACT_FUEL_TYPES.map((ft) => {
    const fields = [`ME_Consumption_${ft.suffix}`, `AE_Consumption_${ft.suffix}`, `Boiler_Consumption_${ft.suffix}`];
    if (ft.extraConsumers) fields.push(`Inert_gas_Consumption_${ft.suffix}`, `Cargo_heating_Consumption_${ft.suffix}`);
    return { name: ft.suffix, robField: ft.robField, consumptionFields: fields };
  });
  return cfg;
}

/** schemaName's continuity config — only log-abstract has a curated ROB chain. */
export function continuityConfigFor(schemaName: string): ContinuityConfig {
  return schemaName === 'log-abstract' ? logAbstractConfig() : defaultConfig();
}

function severityOf(cfg: ContinuityConfig, ruleId: string, deflt: Severity): Severity {
  return cfg.severities[ruleId] ?? deflt;
}

/** Time_Since_Previous_Report on r must match the actual delta to prev. */
export function evaluateTimeChain(r: ContinuityReport, prev: ContinuityReport | null, cfg: ContinuityConfig): Finding[] {
  if (!prev) return [];
  const tsp = getFloat(r, 'Time_Since_Previous_Report');
  if (tsp === undefined) return [];
  const actual = (r.eventTime.getTime() - prev.eventTime.getTime()) / 3_600_000;
  if (Math.abs(tsp - actual) > cfg.timeChainToleranceHours) {
    return [{
      ruleId: RULE_TIME_CHAIN,
      severity: severityOf(cfg, RULE_TIME_CHAIN, 'warning'),
      field: 'Time_Since_Previous_Report',
      message: `Time_Since_Previous_Report is ${tsp.toFixed(2)}h, but ${actual.toFixed(2)}h elapsed since the previous report`,
    }];
  }
  return [];
}

/** ROB(n) = ROB(n-1) - consumption(n) + bunkered(n), for every series in cfg.robSeriesList. */
export function evaluateROBContinuity(r: ContinuityReport, prev: ContinuityReport | null, cfg: ContinuityConfig): Finding[] {
  if (!prev) return [];
  const findings: Finding[] = [];
  for (const s of cfg.robSeriesList) {
    const cur = getFloat(r, s.robField);
    const prior = getFloat(prev, s.robField);
    if (cur === undefined || prior === undefined) continue;
    let consumption = 0;
    for (const f of s.consumptionFields) consumption += getFloat(r, f) ?? 0;
    const bunkered = cfg.bunkeredAmounts[s.name] ?? 0;
    const expected = prior - consumption + bunkered;
    if (Math.abs(cur - expected) > cfg.robToleranceMt) {
      findings.push({
        ruleId: RULE_ROB_CONTINUITY,
        severity: severityOf(cfg, RULE_ROB_CONTINUITY, 'warning'),
        field: s.robField,
        message: `${s.robField} is ${cur.toFixed(2)}, expected ${expected.toFixed(2)} (previous ${prior.toFixed(2)} - consumption ${consumption.toFixed(2)} + bunkered ${bunkered.toFixed(2)})`,
      });
    }
  }
  return findings;
}

/** No two reports in chain may share the same UTC timestamp at minute resolution. */
export function evaluateTimestampUniqueness(chain: ContinuityReport[], cfg: ContinuityConfig): Map<string, Finding[]> {
  const byMinute = new Map<number, ContinuityReport[]>();
  for (const r of chain) {
    const key = Math.floor(r.eventTime.getTime() / 60_000);
    const bucket = byMinute.get(key) ?? [];
    bucket.push(r);
    byMinute.set(key, bucket);
  }
  const out = new Map<string, Finding[]>();
  for (const reports of byMinute.values()) {
    if (reports.length < 2) continue;
    for (const r of reports) {
      const existing = out.get(r.reportId) ?? [];
      existing.push({
        ruleId: RULE_TIMESTAMP_UNIQUENESS,
        severity: severityOf(cfg, RULE_TIMESTAMP_UNIQUENESS, 'error'),
        message: `another report shares the same timestamp ${r.eventTime.toISOString()} at minute resolution`,
      });
      out.set(r.reportId, existing);
    }
  }
  return out;
}

/** Events within each cfg.eventGroups pair must alternate (e.g. Arrival cannot follow Arrival without a Departure). chain must be ordered by eventTime. */
export function evaluateEventOrdering(chain: ContinuityReport[], cfg: ContinuityConfig): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const g of cfg.eventGroups) {
    const stageOf = (eventType: string): number => {
      if (g.stage0.includes(eventType)) return 0;
      if (g.stage1.includes(eventType)) return 1;
      return -1;
    };
    let lastStage = -1;
    for (const r of chain) {
      const stage = stageOf(r.eventType);
      if (stage === -1) continue;
      if (lastStage === stage) {
        const existing = out.get(r.reportId) ?? [];
        existing.push({
          ruleId: RULE_EVENT_ORDERING,
          severity: severityOf(cfg, RULE_EVENT_ORDERING, 'warning'),
          message: `"${r.eventType}" cannot follow another event in the same "${g.name}" sequence without alternating`,
        });
        out.set(r.reportId, existing);
      }
      lastStage = stage;
    }
  }
  return out;
}

export interface CascadeResult {
  /** reportId -> broken rule IDs, in first-seen order. */
  invalidated: Map<string, string[]>;
}

/**
 * Runs the continuity rules across chain and reports which report
 * versions are now invalid (error-severity only — architecture 10.2:
 * warning "allows submit", invalidated "locks the report", so only an
 * error-severity break should invalidate). Recomputes over the full
 * chain every time rather than tracking a "changed from" index — every
 * rule here is linear in chain size and depends only on an immediate
 * neighbor or a single pass, fast enough for a vessel's realistic report
 * volume (see pkg/validation/cascade.go's own doc comment).
 */
export function revalidate(chain: ContinuityReport[], cfg: ContinuityConfig): CascadeResult {
  const sorted = [...chain].sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  const invalidated = new Map<string, string[]>();
  const record = (reportId: string, ruleId: string) => {
    const existing = invalidated.get(reportId) ?? [];
    if (!existing.includes(ruleId)) existing.push(ruleId);
    invalidated.set(reportId, existing);
  };

  let prev: ContinuityReport | null = null;
  for (const r of sorted) {
    if (hasErrors(evaluateTimeChain(r, prev, cfg))) record(r.reportId, RULE_TIME_CHAIN);
    if (hasErrors(evaluateROBContinuity(r, prev, cfg))) record(r.reportId, RULE_ROB_CONTINUITY);
    prev = r;
  }
  for (const [reportId, findings] of evaluateEventOrdering(sorted, cfg)) {
    if (hasErrors(findings)) record(reportId, RULE_EVENT_ORDERING);
  }
  for (const [reportId, findings] of evaluateTimestampUniqueness(sorted, cfg)) {
    if (hasErrors(findings)) record(reportId, RULE_TIMESTAMP_UNIQUENESS);
  }
  return { invalidated };
}
