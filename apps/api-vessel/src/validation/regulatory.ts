import { OvdField } from '../reports/schema-registry.service';
import { FieldEvents, FieldPolicy, ValidationReport, fieldIsEmpty } from './types';
import { policyStateForEvent } from './policy';

export type RegulatoryProfile = 'mrv' | 'dcs' | 'cii' | 'voyageVerification';
type Requirement = 'needed' | 'informational';

export interface ProfileReadiness {
  profile: RegulatoryProfile;
  ready: boolean;
  missingFields: string[];
}

// Ports ovl/pkg/validation/regulatory.go's exact, non-fuzzy relevance
// vocabulary (regulatory.go:60) — an unrecognized relevance string maps
// to no profile at all rather than guessing, matching the original's
// "fails loudly on a new OVD string" behavior.
const RELEVANCE_PROFILES: Record<string, Partial<Record<RegulatoryProfile, Requirement>>> = {
  'mandatory for MRV&DCS': { mrv: 'needed', dcs: 'needed' },
  'recommended for MRV&DCS': { mrv: 'needed', dcs: 'needed' },
  'mandatory for MRV': { mrv: 'needed' },
  'voluntary wrt MRV': { mrv: 'informational' },
  'for CII correction, voluntary wrt MRV': { cii: 'informational', mrv: 'informational' },
  'for CII correction': { cii: 'informational' },
  'DSC only, voluntary wrt MRV': { dcs: 'needed', mrv: 'informational' },
  'mandatory for FEUM and in case of no fuel consumption for any verification': { mrv: 'needed' },
  // "verfication" is a typo in the original OVD schema data — copied
  // verbatim since this string is matched exactly against real schema
  // JSON, not a corrected spelling.
  'recommended for voyage level verfication schemes': { voyageVerification: 'needed' },
};

// Ports EvaluateRegulatoryReadiness. Skips hidden fields entirely; a
// profile with zero relevant VISIBLE fields is omitted from the result
// (not reported as trivially ready) rather than included with an empty
// missingFields array.
export function evaluateRegulatoryReadiness(
  r: ValidationReport,
  fields: OvdField[],
  policy: FieldPolicy,
  events: FieldEvents,
): ProfileReadiness[] {
  const relevantFieldsByProfile = new Map<RegulatoryProfile, { name: string; requirement: Requirement }[]>();

  for (const f of fields) {
    const state = policyStateForEvent(policy, f.name, f.schemaMandatory, f.relevance, events, r.eventType);
    if (state === 'hidden') continue;

    const mapping = f.relevance ? RELEVANCE_PROFILES[f.relevance.trim()] : undefined;
    if (!mapping) continue;

    for (const [profile, requirement] of Object.entries(mapping) as [RegulatoryProfile, Requirement][]) {
      const list = relevantFieldsByProfile.get(profile);
      const entry = { name: f.name, requirement };
      if (list) list.push(entry);
      else relevantFieldsByProfile.set(profile, [entry]);
    }
  }

  const out: ProfileReadiness[] = [];
  for (const [profile, entries] of relevantFieldsByProfile) {
    const missingFields = entries.filter((e) => e.requirement === 'needed' && fieldIsEmpty(r, e.name)).map((e) => e.name);
    out.push({ profile, ready: missingFields.length === 0, missingFields });
  }
  return out;
}
