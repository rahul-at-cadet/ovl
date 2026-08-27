import { formSchemaChecksum } from '@ovl/database';

/**
 * Parsing, validation and field projection for OVD form-schema documents.
 *
 * Pure functions, no I/O — the catalogue services do the database work and
 * call in here for anything that reasons about a document. That split keeps
 * the interesting logic exhaustively testable without a Postgres round trip,
 * and it means the same projection runs for master schemas, tenant uploads and
 * forks, so the three cannot drift.
 */

/** One field as it appears in a curated OVD document. */
export interface FormFieldDocument {
  name: string;
  label?: string | null;
  type: string;
  unit?: string | null;
  maxLength?: number | null;
  enumRef?: string | null;
  schemaMandatory?: boolean;
  mandatoryNote?: string | null;
  relevance?: string | null;
  section?: string | null;
  appliesToEvents?: string[];
  description?: string | null;
  [key: string]: unknown;
}

export interface FormSchemaDocument {
  schemaName: string;
  version: string;
  ovdVersion?: string;
  sections?: string[];
  fields: FormFieldDocument[];
  [key: string]: unknown;
}

/** Field properties that have a dedicated column; everything else goes to `attributes`. */
const KNOWN_FIELD_KEYS = new Set([
  'name',
  'label',
  'type',
  'unit',
  'maxLength',
  'enumRef',
  'schemaMandatory',
  'mandatoryNote',
  'relevance',
  'section',
  'appliesToEvents',
  'description',
]);

export class InvalidFormSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFormSchemaError';
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Structural validation.
 *
 * Deliberately not a JSON Schema meta-schema check. These documents are not
 * JSON Schema — they are OVD field lists that merely happen to be JSON, and
 * the existing office code validating them with Ajv's `validateSchema` is
 * checking a property that says nothing useful about whether the document will
 * render a usable form. What actually matters is checked here: every field has
 * a name and a type, names are unique, and declared sections exist.
 */
export function validateFormSchemaDocument(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['document must be a JSON object'] };
  }

  const doc = input as Partial<FormSchemaDocument>;

  if (typeof doc.schemaName !== 'string' || doc.schemaName.trim() === '') {
    errors.push('schemaName is required');
  }
  if (typeof doc.version !== 'string' || doc.version.trim() === '') {
    errors.push('version is required');
  }
  if (!Array.isArray(doc.fields) || doc.fields.length === 0) {
    errors.push('fields must be a non-empty array');
    return { valid: false, errors };
  }

  const seen = new Set<string>();
  doc.fields.forEach((field, index) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      errors.push(`fields[${index}] must be an object`);
      return;
    }
    if (typeof field.name !== 'string' || field.name.trim() === '') {
      errors.push(`fields[${index}].name is required`);
      return;
    }
    // Duplicate names are the failure worth catching: report values are stored
    // in a name-keyed JSON bag on both office and vessel, so two fields sharing
    // a name means one silently overwrites the other's answer.
    if (seen.has(field.name)) {
      errors.push(`duplicate field name ${JSON.stringify(field.name)}`);
    }
    seen.add(field.name);

    if (typeof field.type !== 'string' || field.type.trim() === '') {
      errors.push(`fields[${index}] (${field.name}) is missing a type`);
    }
  });

  if (doc.sections !== undefined && !Array.isArray(doc.sections)) {
    errors.push('sections must be an array when present');
  }

  if (Array.isArray(doc.sections)) {
    const declared = new Set(doc.sections);
    for (const field of doc.fields) {
      if (field?.section && !declared.has(field.section)) {
        errors.push(
          `field ${JSON.stringify(field.name)} is in section ${JSON.stringify(field.section)}, ` +
            `which is not declared in sections`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function parseFormSchemaDocument(raw: string): FormSchemaDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InvalidFormSchemaError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = validateFormSchemaDocument(parsed);
  if (!result.valid) {
    throw new InvalidFormSchemaError(result.errors.join('; '));
  }
  return parsed as FormSchemaDocument;
}

export interface ProjectedField {
  ordinal: number;
  name: string;
  label: string | null;
  type: string;
  unit: string | null;
  maxLength: number | null;
  enumRef: string | null;
  schemaMandatory: boolean;
  mandatoryNote: string | null;
  relevance: string | null;
  section: string | null;
  appliesToEvents: string[];
  description: string | null;
  attributes: Record<string, unknown>;
}

/**
 * Flattens a document's fields into rows.
 *
 * `ordinal` preserves declaration order, which is render order and therefore
 * meaningful. Anything without a dedicated column is kept in `attributes`
 * rather than dropped: the OVD spec grows, and a projection that silently
 * discarded unrecognised properties would make the row view quietly disagree
 * with the document it came from.
 */
export function projectFields(document: FormSchemaDocument): ProjectedField[] {
  return document.fields.map((field, index) => {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field)) {
      if (!KNOWN_FIELD_KEYS.has(key)) attributes[key] = value;
    }

    return {
      ordinal: index,
      name: field.name,
      label: field.label ?? null,
      type: field.type,
      unit: field.unit ?? null,
      maxLength: typeof field.maxLength === 'number' ? field.maxLength : null,
      enumRef: field.enumRef ?? null,
      schemaMandatory: field.schemaMandatory === true,
      mandatoryNote: field.mandatoryNote ?? null,
      relevance: field.relevance ?? null,
      section: field.section ?? null,
      appliesToEvents: Array.isArray(field.appliesToEvents) ? field.appliesToEvents : [],
      description: field.description ?? null,
      attributes,
    };
  });
}

export interface FieldDiff {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; properties: string[] }>;
}

/**
 * What changed between two versions of a schema.
 *
 * Drives the publish preview, and — more importantly — the question a tenant
 * has to answer when master ships an upgrade for a schema they have forked:
 * what did the platform change, and does it collide with what we changed?
 */
export function diffFields(before: FormFieldDocument[], after: FormFieldDocument[]): FieldDiff {
  const beforeByName = new Map(before.map((f) => [f.name, f]));
  const afterByName = new Map(after.map((f) => [f.name, f]));

  const added = [...afterByName.keys()].filter((name) => !beforeByName.has(name));
  const removed = [...beforeByName.keys()].filter((name) => !afterByName.has(name));

  const changed: FieldDiff['changed'] = [];
  for (const [name, afterField] of afterByName) {
    const beforeField = beforeByName.get(name);
    if (!beforeField) continue;

    const properties = [...new Set([...Object.keys(beforeField), ...Object.keys(afterField)])]
      .filter((key) => formSchemaChecksum(beforeField[key]) !== formSchemaChecksum(afterField[key]))
      .sort();

    if (properties.length > 0) changed.push({ name, properties });
  }

  return { added, removed, changed };
}

/** Every enum this document references, deduplicated. */
export function referencedEnums(document: FormSchemaDocument): string[] {
  const refs = new Set<string>();
  for (const field of document.fields) {
    if (field.enumRef) refs.add(field.enumRef);
  }
  return [...refs].sort();
}
