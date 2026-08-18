import { Scope, coversVessel } from './scope';

/**
 * Ports ovl/office/fieldpolicy/policy.go + migrate.go.
 *
 * A stored field policy only ever contains OVERRIDES. A field absent from
 * `policy`/`prefill`/`events` is "at default" — the default itself (GHG
 * relevance based "recommended" vs "optional", "none" prefill, "applies to
 * every event") is computed by the caller (the frontend's fieldPolicyLogic.ts
 * mirrors this exactly), not by these resolvers.
 */

export const POLICY_STATES = [
  'hidden',
  'optional',
  'recommended',
  'companyMandatory',
  'schemaMandatory',
] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

const STATE_RANK: Record<string, number> = {
  hidden: 0,
  optional: 1,
  recommended: 2,
  companyMandatory: 3,
};

export const PREFILL_CLASSES = ['none', 'carryForward', 'computed', 'ghost'] as const;

export interface SchemaField {
  name: string;
  label: string;
  type: string;
  unit?: string | null;
  maxLength?: number | null;
  enumRef?: string | null;
  schemaMandatory: boolean;
  mandatoryNote?: string | null;
  relevance: string;
  section: string;
  appliesToEvents?: string[];
  description?: string;
}

export interface FieldPolicyAssignment {
  scope: Scope;
  schemaName: string;
  schemaVersion: string;
  policy: Record<string, string>;
  prefill: Record<string, string>;
  events: Record<string, string[]>;
}

export interface EffectiveFieldPolicy {
  policy: Record<string, string>;
  prefill: Record<string, string>;
  events: Record<string, string[]>;
}

function hasRule(a: FieldPolicyAssignment | undefined, fieldName: string): boolean {
  if (!a) return false;
  return a.policy[fieldName] !== undefined || a.events[fieldName] !== undefined;
}

function strictestGroupRule(
  groupAssignments: FieldPolicyAssignment[],
  fieldName: string,
): FieldPolicyAssignment | undefined {
  let best: FieldPolicyAssignment | undefined;
  let bestRank = -2;
  for (const a of groupAssignments) {
    if (!hasRule(a, fieldName)) continue;
    const state = a.policy[fieldName];
    const rank = state !== undefined ? STATE_RANK[state] ?? 1 : -1;
    if (rank > bestRank) {
      bestRank = rank;
      best = a;
    }
  }
  return best;
}

/** vessel's own rule wins outright; else strictest covering group; else fleet. */
function winningRule(
  vesselAssignment: FieldPolicyAssignment | undefined,
  fleetAssignment: FieldPolicyAssignment | undefined,
  groupAssignments: FieldPolicyAssignment[],
  fieldName: string,
): FieldPolicyAssignment | undefined {
  if (hasRule(vesselAssignment, fieldName)) return vesselAssignment;
  const group = strictestGroupRule(groupAssignments, fieldName);
  if (group) return group;
  if (hasRule(fleetAssignment, fieldName)) return fleetAssignment;
  return undefined;
}

/**
 * Per-field resolution: a field's policy state and its event narrowing are
 * one rule authored on one editor row, and are always resolved and copied
 * together from a single winning assignment — never mixed across scopes.
 * Prefill has no such pairing and resolves independently (vessel -> first
 * covering group in list order -> fleet).
 */
export function effectiveFieldPolicy(
  assignments: FieldPolicyAssignment[],
  vesselId: string,
  vesselGroups: string[],
  schemaName: string,
  schemaVersion: string,
): EffectiveFieldPolicy {
  const matching = assignments.filter(
    (a) => a.schemaName === schemaName && a.schemaVersion === schemaVersion,
  );
  const vesselAssignment = matching.find((a) => a.scope.type === 'vessel' && a.scope.key === vesselId);
  const fleetAssignment = matching.find((a) => a.scope.type === 'fleet');
  const groupAssignments = matching.filter(
    (a) => a.scope.type === 'group' && coversVessel(a.scope, vesselId, vesselGroups),
  );

  const fieldNames = new Set<string>();
  for (const a of matching) {
    Object.keys(a.policy).forEach((n) => fieldNames.add(n));
    Object.keys(a.events).forEach((n) => fieldNames.add(n));
  }

  const policy: Record<string, string> = {};
  const events: Record<string, string[]> = {};
  for (const fieldName of fieldNames) {
    const winner = winningRule(vesselAssignment, fleetAssignment, groupAssignments, fieldName);
    if (!winner) continue;
    if (winner.policy[fieldName] !== undefined) policy[fieldName] = winner.policy[fieldName];
    if (winner.events[fieldName] !== undefined) events[fieldName] = winner.events[fieldName];
  }

  const prefillNames = new Set<string>();
  for (const a of matching) Object.keys(a.prefill).forEach((n) => prefillNames.add(n));
  const prefill: Record<string, string> = {};
  for (const fieldName of prefillNames) {
    if (vesselAssignment?.prefill[fieldName] !== undefined) {
      prefill[fieldName] = vesselAssignment.prefill[fieldName];
      continue;
    }
    const group = groupAssignments.find((a) => a.prefill[fieldName] !== undefined);
    if (group) {
      prefill[fieldName] = group.prefill[fieldName];
      continue;
    }
    if (fleetAssignment?.prefill[fieldName] !== undefined) {
      prefill[fieldName] = fleetAssignment.prefill[fieldName];
    }
  }

  return { policy, prefill, events };
}

export interface SchemaDiff {
  added: SchemaField[];
  removed: SchemaField[];
  typeChanged: string[];
  mandatorinessChanged: string[];
  enumChanged: string[];
}

export function diffSchemaFields(oldFields: SchemaField[], newFields: SchemaField[]): SchemaDiff {
  const oldByName = new Map(oldFields.map((f) => [f.name, f]));
  const newByName = new Map(newFields.map((f) => [f.name, f]));

  const added = newFields.filter((f) => !oldByName.has(f.name));
  const removed = oldFields.filter((f) => !newByName.has(f.name));
  const typeChanged: string[] = [];
  const mandatorinessChanged: string[] = [];
  const enumChanged: string[] = [];

  for (const [name, oldField] of oldByName) {
    const newField = newByName.get(name);
    if (!newField) continue;
    if (oldField.type !== newField.type) typeChanged.push(name);
    if (oldField.schemaMandatory !== newField.schemaMandatory) mandatorinessChanged.push(name);
    if ((oldField.enumRef ?? null) !== (newField.enumRef ?? null)) enumChanged.push(name);
  }

  return { added, removed, typeChanged, mandatorinessChanged, enumChanged };
}

export function schemaDiffEmpty(diff: SchemaDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.typeChanged.length === 0 &&
    diff.mandatorinessChanged.length === 0 &&
    diff.enumChanged.length === 0
  );
}

export interface MigrationResult {
  policy: Record<string, string>;
  prefill: Record<string, string>;
  events: Record<string, string[]>;
  newFields: string[];
  removedFields: string[];
}

/**
 * Carries forward policy/prefill/events overrides to a new schema version,
 * dropping anything that referenced a now-removed field (a removed field's
 * override is meaningless; if a future version reintroduces the same name
 * it starts fresh rather than resurrecting a stale override). Added fields
 * get no entry — absent-from-map already defaults to optional/none.
 */
export function migrateFieldPolicy(
  oldPolicy: Record<string, string>,
  oldPrefill: Record<string, string>,
  oldEvents: Record<string, string[]>,
  diff: SchemaDiff,
): MigrationResult {
  const removedNames = new Set(diff.removed.map((f) => f.name));

  const policy: Record<string, string> = {};
  for (const [name, v] of Object.entries(oldPolicy)) if (!removedNames.has(name)) policy[name] = v;

  const prefill: Record<string, string> = {};
  for (const [name, v] of Object.entries(oldPrefill)) if (!removedNames.has(name)) prefill[name] = v;

  const events: Record<string, string[]> = {};
  for (const [name, v] of Object.entries(oldEvents)) if (!removedNames.has(name)) events[name] = v;

  return {
    policy,
    prefill,
    events,
    newFields: diff.added.map((f) => f.name),
    removedFields: diff.removed.map((f) => f.name),
  };
}

/** A schema "has an event concept" iff one of its fields enumerates event-types. */
export function hasEventConcept(fields: SchemaField[]): boolean {
  return fields.some((f) => f.enumRef === 'event-types');
}

/**
 * Voyage event-type vocabulary, mirroring the Go build's embedded
 * ovl/schemas/ovd-3.13/enums/event-types.json (values[].code).
 */
export const EVENT_TYPE_CODES: string[] = [
  'Arrival',
  'Departure',
  'ArrivalSTS',
  'DepartureSTS',
  'STS',
  'BOSP',
  'EOSP',
  'BeginOfSeaPassage',
  'EndOfSeaPassage',
  'FAOP',
  'FullAheadOnPassage',
  'BeginOfShifting',
  'EndOfShifting',
  'Begin canal passage',
  'End canal passage',
  'Begin Anchoring/Drifting',
  'End Anchoring/Drifting',
  'Noon (Position) - Sea passage',
  'Noon (Position) - Port',
  'Noon (Position) - River',
  'Noon (Position) - Stoppage',
  'ETA update',
  'Begin fuel change over',
  'End fuel change over',
  'Change destination (Deviation)',
  'Begin of deviation',
  'End of deviation',
  'Entering special area',
  'Leaving special area',
  'Other event',
  'Beginofoffhire',
  'Endofoffhire',
  'Performance snapshot',
];

/**
 * Save-time filtering matching Go's handleSaveFieldPolicy: silently drop
 * entries for fields that no longer exist in the current schema, or that
 * are schema-mandatory (immutable — company policy can never touch them).
 */
export function filterSavePolicy(
  fields: SchemaField[],
  policy: Record<string, string>,
): Record<string, string> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, string> = {};
  for (const [name, state] of Object.entries(policy)) {
    const field = byName.get(name);
    if (!field || field.schemaMandatory) continue;
    out[name] = state;
  }
  return out;
}

export function filterSavePrefill(
  fields: SchemaField[],
  prefill: Record<string, string>,
): Record<string, string> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, string> = {};
  for (const [name, cls] of Object.entries(prefill)) {
    if (!byName.has(name)) continue;
    out[name] = cls;
  }
  return out;
}

/**
 * Silently drops entries for unknown/schema-mandatory fields; throws if the
 * schema has no event concept at all but the caller still sent narrowing.
 */
export function filterSaveEvents(
  fields: SchemaField[],
  events: Record<string, string[]>,
): Record<string, string[]> {
  if (!hasEventConcept(fields)) {
    if (Object.keys(events).length > 0) {
      throw new Error('this schema has no event concept; events must be empty');
    }
    return {};
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(events)) {
    const field = byName.get(name);
    if (!field || field.schemaMandatory) continue;
    out[name] = list;
  }
  return out;
}
