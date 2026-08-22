import { FieldEvents, FieldPolicy, FieldPolicyState, eventsAppliesTo } from './types';

// Ports ovl/pkg/validation/policy.go. Deliberately does NOT read the
// schema's own `appliesToEvents` array — per-event gating comes from the
// *company config bundle's* events map (FieldEvents here), matching the
// original exactly.
const GHG_RELEVANT_PROFILES = new Set([
  'mandatory for MRV&DCS',
  'recommended for MRV&DCS',
  'mandatory for MRV',
  'voluntary wrt MRV',
  'for CII correction, voluntary wrt MRV',
  'for CII correction',
  'DSC only, voluntary wrt MRV',
  'mandatory for FEUM and in case of no fuel consumption for any verification',
  'recommended for voyage level verfication schemes',
]);

export function ghgRelevant(relevance: string | undefined): boolean {
  if (!relevance) return false;
  return GHG_RELEVANT_PROFILES.has(relevance.trim());
}

export function policyStateFor(
  policy: FieldPolicy,
  fieldName: string,
  schemaMandatory: boolean,
  relevance: string | undefined,
): FieldPolicyState {
  if (schemaMandatory) return 'schemaMandatory';
  const configured = policy[fieldName];
  if (configured) return configured;
  if (ghgRelevant(relevance)) return 'recommended';
  return 'optional';
}

export function policyStateForEvent(
  policy: FieldPolicy,
  fieldName: string,
  schemaMandatory: boolean,
  relevance: string | undefined,
  events: FieldEvents,
  eventType: string,
): FieldPolicyState {
  if (schemaMandatory) return 'schemaMandatory';
  if (!eventsAppliesTo(events, fieldName, eventType)) return 'hidden';
  return policyStateFor(policy, fieldName, schemaMandatory, relevance);
}
