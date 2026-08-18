export type ScopeType = "fleet" | "group" | "vessel";

export type Scope = {
  type: ScopeType;
  key?: string;
};

export const PROFILE_LABELS: Record<string, string> = {
  mrv: "MRV / ETS / FuelEU Maritime",
  dcs: "DCS",
  cii: "CII corrections",
  voyageVerification: "Voyage-level verification",
};

export const ALL_PROFILES = ["mrv", "dcs", "cii", "voyageVerification"];

export const RULE_LABELS: Record<string, string> = {
  "plausibility.timeBucketSum": "Time bucket sum",
  "plausibility.impliedSpeed": "Implied speed",
  "plausibility.noDistanceStationary": "No distance while stationary",
  "plausibility.positionRequired": "Position required",
  "plausibility.positionConsistency": "Position consistency",
  "continuity.timeChain": "Time chain continuity",
  "continuity.robContinuity": "ROB continuity",
  "continuity.eventOrdering": "Event ordering",
  "continuity.timestampUniqueness": "Timestamp uniqueness",
  "plausibility.consumptionSchemeExclusivity": "Consumption scheme exclusivity",
};

export function ruleLabel(ruleID: string): string {
  return RULE_LABELS[ruleID] ?? ruleID;
}

export function scopeLabel(scope: Scope, vessels: { id: string; name: string }[] = []): string {
  if (scope.type === "fleet") return "Fleet-wide";
  if (scope.type === "group") return `Group: ${scope.key}`;
  const vessel = vessels.find((v) => v.id === scope.key);
  return vessel ? `Vessel: ${vessel.name}` : `Vessel: ${scope.key}`;
}

export function scopeKey(scope: Scope): string {
  return `${scope.type}:${scope.key ?? ""}`;
}

export function scopesEqual(a: Scope, b: Scope): boolean {
  return a.type === b.type && (a.key ?? "") === (b.key ?? "");
}
