import { Finding, ValidationConfig, ValidationReport } from './types';
import { evaluateEventOrdering, evaluateRobContinuity, evaluateTimeChain, evaluateTimestampUniqueness } from './continuity';

// Ports ovl/pkg/validation/precheck.go's EvaluateContinuity — runs
// against the committed chain PLUS r itself (r replaces its own earlier
// version in the chain, matched by reportId, since a correction slots
// into its predecessor's position rather than adding a second entry).
// Returns only r's own findings, never the neighbours'.
//
// The merge-then-stable-sort-then-find-neighbor dance matters: ties
// (identical eventTime) keep insertion order, and r is appended last
// among the non-r entries, so on a tie r sorts after its neighbour with
// the same timestamp — matching Go's sort.SliceStable exactly. Array.
// prototype.sort is stable in modern V8/Node, so this is a direct port.
export function evaluateContinuity(r: ValidationReport, chain: ValidationReport[], cfg: ValidationConfig): Finding[] {
  const merged = chain.filter((other) => other.reportId !== r.reportId);
  merged.push(r);
  merged.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());

  let prev: ValidationReport | null = null;
  let findings: Finding[] = [];
  for (const candidate of merged) {
    if (candidate.reportId === r.reportId) {
      findings = [...evaluateTimeChain(r, prev, cfg), ...evaluateRobContinuity(r, prev, cfg)];
      break;
    }
    prev = candidate;
  }

  findings.push(...(evaluateEventOrdering(merged, cfg).get(r.reportId) ?? []));
  findings.push(...(evaluateTimestampUniqueness(merged, cfg).get(r.reportId) ?? []));
  return findings;
}
