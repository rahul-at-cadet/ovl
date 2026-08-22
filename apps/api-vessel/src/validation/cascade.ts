import { ValidationConfig, ValidationReport, hasErrors } from './types';
import { evaluateEventOrdering, evaluateRobContinuity, evaluateTimeChain, evaluateTimestampUniqueness } from './continuity';

export interface CascadeResult {
  // reportId -> broken rule ids, in first-seen order (deduped)
  invalidated: Map<string, string[]>;
}

export function cascadeIsInvalidated(result: CascadeResult, reportId: string): boolean {
  return (result.invalidated.get(reportId)?.length ?? 0) > 0;
}

// Ports ovl/pkg/validation/cascade.go's Revalidate. Only ERROR-severity
// violations invalidate a report — with default severities, timeChain and
// robContinuity are warnings (never invalidate unless a config bundle
// raises them to error, which this port doesn't currently wire — see
// config.ts's own comment), so timestampUniqueness (error by default) is
// the only rule that invalidates out of the box.
//
// There is no cascade window or fixed-point iteration: the WHOLE chain is
// recomputed on every call, deliberately (matches the original's own
// documented simplification of "revalidate until results stabilize" —
// every rule here is either neighbour-local or one-pass, so a single
// forward sweep already reaches a fixed point).
export function revalidate(chain: ValidationReport[], cfg: ValidationConfig): CascadeResult {
  const sorted = [...chain].sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());

  const invalidated = new Map<string, string[]>();
  const record = (reportId: string, ruleId: string) => {
    const existing = invalidated.get(reportId);
    if (existing) {
      if (!existing.includes(ruleId)) existing.push(ruleId);
    } else {
      invalidated.set(reportId, [ruleId]);
    }
  };

  let prev: ValidationReport | null = null;
  for (const r of sorted) {
    if (hasErrors(evaluateTimeChain(r, prev, cfg))) record(r.reportId, 'continuity.timeChain');
    if (hasErrors(evaluateRobContinuity(r, prev, cfg))) record(r.reportId, 'continuity.robContinuity');
    prev = r;
  }

  // Fixed statement order (eventOrdering before timestampUniqueness)
  // rather than iterating a Map, so the relative order of these two rule
  // ids in a report's invalidated-rules array is deterministic — it isn't
  // in the Go source (map iteration), but determinism costs nothing here
  // and avoids a flaky-looking diff in stored invalidatedRules.
  for (const [reportId, findings] of evaluateEventOrdering(sorted, cfg)) {
    if (hasErrors(findings)) record(reportId, 'continuity.eventOrdering');
  }
  for (const [reportId, findings] of evaluateTimestampUniqueness(sorted, cfg)) {
    if (hasErrors(findings)) record(reportId, 'continuity.timestampUniqueness');
  }

  return { invalidated };
}
