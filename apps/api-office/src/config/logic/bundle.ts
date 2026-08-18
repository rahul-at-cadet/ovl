import { Scope, coversVessel } from './scope';
import { FieldPolicyAssignment, effectiveFieldPolicy } from './fieldPolicy';
import {
  CadenceRule,
  ProfileAssignment,
  RuleSeverityAssignment,
  effectiveCadence,
  effectiveProfiles,
  effectiveSeverities,
} from './compliance';

/**
 * Ports ovl/office/configbundle/{assignment,bundle}.go and
 * ovl/pkg/configwire/bundle.go. Pure resolution/flattening only — the
 * actual DB fetch ("compose the bundle a Publish call would capture right
 * now") lives in ConfigBundleService since it's I/O, not domain logic.
 */

export interface SchemaVersionRef {
  schemaName: string;
  version: string;
  id: string;
}

export interface ComposedBundleContent {
  schemaVersions: SchemaVersionRef[];
  fieldPolicies: FieldPolicyAssignment[];
  regulatoryProfiles: ProfileAssignment[];
  cadenceRules: CadenceRule[];
  ruleSeverities: RuleSeverityAssignment[];
  defaultRoleNames: string[];
}

export interface BundleAssignmentRecord {
  scope: Scope;
  bundleId: string;
}

/**
 * vessel > group > fleet, first match wins (no tie-break is defined if a
 * vessel is in multiple assigned groups — this is an explicitly documented
 * default in the Go source, not "true" precedence).
 */
export function resolveBundleAssignment(
  assignments: BundleAssignmentRecord[],
  vesselId: string,
  vesselGroups: string[],
): BundleAssignmentRecord | undefined {
  const vesselAssignment = assignments.find((a) => a.scope.type === 'vessel' && a.scope.key === vesselId);
  if (vesselAssignment) return vesselAssignment;

  const groupAssignment = assignments.find(
    (a) => a.scope.type === 'group' && coversVessel(a.scope, vesselId, vesselGroups),
  );
  if (groupAssignment) return groupAssignment;

  return assignments.find((a) => a.scope.type === 'fleet');
}

export const WIRE_VERSION = 1;

export interface WireSchemaConfig {
  schemaName: string;
  version: string;
  policy: Record<string, string>;
  prefill: Record<string, string>;
  events: Record<string, string[]>;
}

export interface WireBundle {
  wireVersion: number;
  bundleId: string;
  versionNo: number;
  publishedAt: string;
  schemas: WireSchemaConfig[];
  regulatoryProfiles: string[];
  maxGapHours: number;
  ruleSeverities: Record<string, string>;
  defaultRoleNames: string[];
}

/**
 * Flattens a composed bundle for one vessel. Resolution happens office-side
 * so the wire document stays trivial and never leaks one vessel's config
 * into another vessel's payload. A bundle with zero assignments for a
 * schema still yields a present-but-empty policy map, never absent.
 */
export function resolveConfigForVessel(
  bundleId: string,
  versionNo: number,
  publishedAt: string,
  content: ComposedBundleContent,
  vesselId: string,
  vesselGroups: string[],
): WireBundle {
  const schemas: WireSchemaConfig[] = content.schemaVersions.map((sv) => {
    const effective = effectiveFieldPolicy(
      content.fieldPolicies,
      vesselId,
      vesselGroups,
      sv.schemaName,
      sv.version,
    );
    return {
      schemaName: sv.schemaName,
      version: sv.version,
      policy: effective.policy,
      prefill: effective.prefill,
      events: effective.events,
    };
  });

  const cadence = effectiveCadence(content.cadenceRules, vesselId, vesselGroups);

  return {
    wireVersion: WIRE_VERSION,
    bundleId,
    versionNo,
    publishedAt,
    schemas,
    regulatoryProfiles: effectiveProfiles(content.regulatoryProfiles, vesselId, vesselGroups),
    maxGapHours: cadence.maxGapHours,
    ruleSeverities: effectiveSeverities(content.ruleSeverities, vesselId, vesselGroups),
    defaultRoleNames: content.defaultRoleNames,
  };
}
