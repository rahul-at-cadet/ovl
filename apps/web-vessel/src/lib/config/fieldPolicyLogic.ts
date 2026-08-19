// Mirrors apps/web-office/src/lib/config/fieldPolicyLogic.ts exactly —
// the original Go project hand-copies this same logic three ways (Go +
// both frontends, see that file's own history), so this is a deliberate
// continuation of that pattern, not accidental duplication.

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

export const POLICY_STATES = [
  { value: "hidden", label: "Hidden" },
  { value: "optional", label: "Optional" },
  { value: "recommended", label: "Recommended" },
  { value: "companyMandatory", label: "Mandatory" },
  { value: "schemaMandatory", label: "Schema" },
] as const;

export const PREFILL_CLASSES = ["none", "carryForward", "computed", "ghost"];

const GHG_RELEVANT_STRINGS = new Set<string>([
  "mandatory for MRV&DCS",
  "recommended for MRV&DCS",
  "mandatory for MRV",
  "voluntary wrt MRV",
  "for CII correction, voluntary wrt MRV",
  "for CII correction",
  "DSC only, voluntary wrt MRV",
  "mandatory for FEUM and in case of no fuel consumption for any verification",
  "recommended for voyage level verfication schemes",
]);

export function appliesToEvent(
  fieldName: string,
  events: Record<string, string[]> | undefined,
  eventType: string | undefined,
): boolean {
  if (!eventType) return true;
  const list = events?.[fieldName];
  if (!list || list.length === 0) return true;
  return list.some((e) => e === "*" || e === eventType);
}

export function effectiveState(
  field: SchemaField,
  policy: Record<string, string>,
  events?: Record<string, string[]>,
  eventType?: string,
): string {
  if (field.schemaMandatory) return "schemaMandatory";
  if (!appliesToEvent(field.name, events, eventType)) return "hidden";
  const explicit = policy[field.name];
  if (explicit) return explicit;
  return GHG_RELEVANT_STRINGS.has(field.relevance.trim()) ? "recommended" : "optional";
}

export function effectivePrefill(field: SchemaField, prefill: Record<string, string>): string {
  return prefill[field.name] ?? "none";
}
