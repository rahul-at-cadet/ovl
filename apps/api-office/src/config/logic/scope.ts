/**
 * Shared scope concept used across every configuration sub-domain (field
 * policy, regulatory profiles, cadence rules, rule severities, config
 * bundle assignments). Ports ovl/office/compliance/scope.go.
 */

export type ScopeType = 'fleet' | 'group' | 'vessel';

export interface Scope {
  type: ScopeType;
  key?: string;
}

export function fleetScope(): Scope {
  return { type: 'fleet' };
}

export function groupScope(group: string): Scope {
  const key = group.trim();
  if (!key) throw new Error('group scope requires a non-empty key');
  return { type: 'group', key };
}

export function vesselScope(vesselId: string): Scope {
  const key = vesselId.trim();
  if (!key) throw new Error('vessel scope requires a non-empty key');
  return { type: 'vessel', key };
}

export function validateScope(scope: Scope): void {
  if (scope.type === 'fleet') {
    if (scope.key) throw new Error('fleet scope must not have a key');
    return;
  }
  if (scope.type === 'group' || scope.type === 'vessel') {
    if (!scope.key || !scope.key.trim()) {
      throw new Error(`${scope.type} scope requires a non-empty key`);
    }
    return;
  }
  throw new Error(`unknown scope type: ${(scope as Scope).type}`);
}

/**
 * The single scope-matching primitive reused by every effective-value
 * resolver: fleet always covers, vessel only covers an exact ID match,
 * group covers when the vessel's group list contains the scope's key.
 */
export function coversVessel(scope: Scope, vesselId: string, vesselGroups: string[]): boolean {
  if (scope.type === 'fleet') return true;
  if (scope.type === 'vessel') return scope.key === vesselId;
  if (scope.type === 'group') return !!scope.key && vesselGroups.includes(scope.key);
  return false;
}

/** DB scope columns shared by every scope-partitioned table. */
export interface ScopeColumns {
  scopeType: string;
  vesselId: string | null;
  groupTag: string | null;
}

export function scopeToColumns(scope: Scope): ScopeColumns {
  return {
    scopeType: scope.type,
    vesselId: scope.type === 'vessel' ? scope.key ?? null : null,
    groupTag: scope.type === 'group' ? scope.key ?? null : null,
  };
}

export function scopeFromColumns(row: ScopeColumns): Scope {
  const type = row.scopeType as ScopeType;
  if (type === 'vessel') return { type, key: row.vesselId ?? undefined };
  if (type === 'group') return { type, key: row.groupTag ?? undefined };
  return { type: 'fleet' };
}
