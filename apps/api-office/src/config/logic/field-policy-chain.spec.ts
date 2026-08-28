import { readFileSync } from 'fs';
import { join } from 'path';
import { filterSavePolicy, SchemaField } from './fieldPolicy';
import { resolveConfigForVessel, ComposedBundleContent } from './bundle';

// --- copy of apps/web-vessel/src/lib/config/fieldPolicyLogic.ts -------------
const GHG = new Set<string>([
  'mandatory for MRV&DCS', 'recommended for MRV&DCS', 'mandatory for MRV',
  'voluntary wrt MRV', 'for CII correction, voluntary wrt MRV', 'for CII correction',
  'DSC only, voluntary wrt MRV',
  'mandatory for FEUM and in case of no fuel consumption for any verification',
  'recommended for voyage level verfication schemes',
]);
function appliesToEvent(n: string, ev: Record<string, string[]> | undefined, t?: string) {
  if (!t) return true;
  const l = ev?.[n];
  if (!l || l.length === 0) return true;
  return l.some((e) => e === '*' || e === t);
}
function effectiveState(f: SchemaField, policy: Record<string, string>, ev?: Record<string, string[]>, t?: string) {
  if (f.schemaMandatory) return 'schemaMandatory';
  if (!appliesToEvent(f.name, ev, t)) return 'hidden';
  const explicit = policy[f.name];
  if (explicit) return explicit;
  return GHG.has((f.relevance ?? '').trim()) ? 'recommended' : 'optional';
}
// --- copy of api-vessel getFieldPolicy's bundle lookup ---------------------
function vesselGetFieldPolicy(bundleJson: string, schemaName: string) {
  const empty = { policy: {}, prefill: {}, events: {} };
  try {
    const bundle = JSON.parse(bundleJson);
    const bare = schemaName.replace(/\.json$/, '');
    const match = (bundle.schemas || []).find((s: any) => s.schemaName === bare);
    if (!match) return empty;
    return { policy: match.policy || {}, prefill: match.prefill || {}, events: match.events || {} };
  } catch { return empty; }
}

const doc = JSON.parse(readFileSync(join(__dirname, '../../schemas/log-abstract.json'), 'utf-8'));
const FIELDS: SchemaField[] = doc.fields;
const VESSEL = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const HIDDEN_FIELD = 'Voyage_From';

describe('field-policy chain: office save -> bundle -> vessel -> ReportForm', () => {
  it('walks the whole chain and hides the field', () => {
    // 1. office save
    const saved = filterSavePolicy(FIELDS, { [HIDDEN_FIELD]: 'hidden' });
    expect(saved).toEqual({ [HIDDEN_FIELD]: 'hidden' });

    // 2. compose (what publish snapshots)
    const content: ComposedBundleContent = {
      schemaVersions: [{ schemaName: doc.schemaName, version: doc.version, id: 'sv-1' }],
      fieldPolicies: [{
        scope: { type: 'vessel', key: VESSEL },
        schemaName: doc.schemaName, schemaVersion: doc.version,
        policy: saved, prefill: {}, events: {},
      }],
      regulatoryProfiles: [], cadenceRules: [], ruleSeverities: [], defaultRoleNames: [],
    };

    // 3. resolve for vessel -> wire bundle
    const wire = resolveConfigForVessel('b-1', 7, '2026-01-01T00:00:00Z', content, VESSEL, []);
    console.log('WIRE schemas:', JSON.stringify(wire.schemas.map((s) => ({ n: s.schemaName, v: s.version, p: s.policy }))));

    // 4. vessel getFieldPolicy (report.schemaName carries .json)
    const got = vesselGetFieldPolicy(JSON.stringify(wire), 'log-abstract.json');
    console.log('VESSEL policy:', JSON.stringify(got.policy));

    // 5. ReportForm effective state
    const field = FIELDS.find((f) => f.name === HIDDEN_FIELD)!;
    const state = effectiveState(field, got.policy, got.events, 'Departure');
    console.log('EFFECTIVE STATE:', state);
    expect(state).toBe('hidden');
  });

  it('leaves a different vessel untouched', () => {
    const content: ComposedBundleContent = {
      schemaVersions: [{ schemaName: doc.schemaName, version: doc.version, id: 'sv-1' }],
      fieldPolicies: [{
        scope: { type: 'vessel', key: VESSEL },
        schemaName: doc.schemaName, schemaVersion: doc.version,
        policy: { [HIDDEN_FIELD]: 'hidden' }, prefill: {}, events: {},
      }],
      regulatoryProfiles: [], cadenceRules: [], ruleSeverities: [], defaultRoleNames: [],
    };
    const wire = resolveConfigForVessel('b-1', 7, '2026-01-01T00:00:00Z', content, OTHER, []);
    const got = vesselGetFieldPolicy(JSON.stringify(wire), 'log-abstract.json');
    const field = FIELDS.find((f) => f.name === HIDDEN_FIELD)!;
    console.log('OTHER VESSEL state:', effectiveState(field, got.policy, got.events, 'Departure'));
    expect(effectiveState(field, got.policy, got.events, 'Departure')).not.toBe('hidden');
  });

  it('refuses to hide a schema-mandatory field', () => {
    const saved = filterSavePolicy(FIELDS, { IMO: 'hidden' });
    console.log('MANDATORY save filtered to:', JSON.stringify(saved));
    expect(saved).toEqual({});
  });
});
