import {
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { desc } from 'drizzle-orm';
import * as vesselSchema from '@ovl/vessel-database';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as fs from 'fs';
import * as path from 'path';
import { Type, TSchema } from '@sinclair/typebox';
import { TypeCompiler, TypeCheck } from '@sinclair/typebox/compiler';
import { InvalidInputError } from '../common/app-error';

export type OvdField = {
  name: string;
  type: string;
  schemaMandatory: boolean;
  maxLength?: number;
  label?: string;
  section?: string;
  description?: string;
  enumRef?: string | null;
  relevance?: string;
};

export type OvdSchema = {
  schemaName: string;
  sections?: string[];
  fields: OvdField[];
};

@Injectable()
export class SchemaRegistryService implements OnModuleInit {
  private readonly logger = new Logger(SchemaRegistryService.name);
  private readonly compilers = new Map<string, TypeCheck<any>>();
  private readonly originalSchemas = new Map<string, OvdSchema>();
  private readonly enums = new Map<string, string[]>();
  /**
   * The same enums with their human-readable remarks kept.
   *
   * `enums` holds bare codes because that is all validation needs, which
   * meant the remark in every curated enum file was read and thrown away
   * — and the remark is the only thing that makes a code like
   * "ArrivalSTS" mean something to an officer choosing from a list.
   */
  private readonly enumDetails = new Map<string, { code: string; remark?: string }[]>();
  /** Which source each compiled schema came from, for the log line only. */
  private readonly origin = new Map<string, string>();

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: any,
  ) {}

  async onModuleInit() {
    this.loadSchemas();
    this.loadEnums();
    await this.loadSyncedSchemas();
  }

  /**
   * Re-reads the schemas the office has published to this vessel.
   *
   * Called at boot and again whenever a sync brings new versions down, so
   * a published schema takes effect without restarting the node — the
   * point of syncing them at all is that a ship at sea cannot be asked to
   * reboot to pick up a new report form.
   *
   * Office-published schemas win over the copies baked into this build.
   * The bundled files stay as the floor: a vessel that has never synced,
   * or one whose office is unreachable on first boot, still has working
   * report forms rather than none.
   */
  async loadSyncedSchemas(): Promise<number> {
    let rows: { schemaName: string; version: string; content: string; publishedAt: string }[];
    try {
      rows = await this.db
        .select()
        .from(vesselSchema.schemaVersions)
        .orderBy(desc(vesselSchema.schemaVersions.publishedAt));
    } catch (err: any) {
      // Never fatal. A vessel that cannot read this table still has its
      // bundled schemas and can keep reporting.
      this.logger.error(`Could not read synced schemas: ${err.message}`);
      return 0;
    }

    // Newest published wins, and every older version is kept in the table
    // so a report filed under one remains explainable.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latest.has(row.schemaName)) latest.set(row.schemaName, row);
    }

    let applied = 0;
    for (const row of latest.values()) {
      // Office names schemas bare ("bunker-report"); this registry keys on
      // the vessel's own ".json" convention, the same normalisation the
      // field-policy lookup already performs in the other direction.
      const key = row.schemaName.endsWith('.json') ? row.schemaName : `${row.schemaName}.json`;
      try {
        const schemaDef: OvdSchema = JSON.parse(row.content);
        if (!Array.isArray(schemaDef.fields) || schemaDef.fields.length === 0) {
          throw new Error('schema declares no fields');
        }
        const compiler = TypeCompiler.Compile(this.buildTypeBoxSchema(schemaDef));
        // Swapped in only once both the parse and the compile have
        // succeeded, so a malformed document office published cannot
        // leave this vessel with a schema it can no longer validate
        // against — it keeps the previous one and says so.
        this.compilers.set(key, compiler);
        this.originalSchemas.set(key, schemaDef);
        this.origin.set(key, `office@${row.version}`);
        applied++;
      } catch (err: any) {
        this.logger.error(
          `Office-published schema ${row.schemaName}@${row.version} is unusable (${err.message}); keeping ${this.origin.get(key) ?? 'the bundled copy'}.`,
        );
      }
    }
    if (applied > 0) this.logger.log(`Applied ${applied} office-published schema(s).`);
    return applied;
  }

  private loadSchemas() {
    // process.cwd() will be apps/api-vessel
    const schemasDir = path.join(process.cwd(), 'src', 'schemas');
    if (!fs.existsSync(schemasDir)) {
      this.logger.warn(`Schemas directory not found at ${schemasDir}`);
      return;
    }

    const files = fs.readdirSync(schemasDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(schemasDir, file), 'utf8');
        const schemaDef: OvdSchema = JSON.parse(content);

        // Use the schemaName inside the JSON or the filename
        const schemaName = schemaDef.schemaName + '.json';
        const typeboxSchema = this.buildTypeBoxSchema(schemaDef);

        // Compile to highly optimized validation function
        const compiler = TypeCompiler.Compile(typeboxSchema);
        this.compilers.set(schemaName, compiler);
        this.originalSchemas.set(schemaName, schemaDef);
        this.origin.set(schemaName, 'bundled');

        this.logger.log(`Loaded and compiled schema: ${schemaName}`);
      } catch (err: any) {
        this.logger.error(`Failed to compile schema ${file}: ${err.message}`);
      }
    }
  }

  // Curated enumRef files (e.g. bunker-report's Fuel_Type field pointing
  // at "fuel-types") — ported from the original's pkg/schema.ResolveEnum.
  //
  // Two document shapes exist in the curated set. Most list {code,label}
  // under `values`. offshore-modes instead lists {highLevelMode,
  // reportingMode} under `modes`, where reportingMode is the code an officer
  // actually picks and highLevelMode is only a grouping. Reading `values`
  // alone left that one unresolved, so log-abstract's Activity_Mode fell
  // through to unrestricted text entry and collected free text instead of a
  // controlled vocabulary.
  private loadEnums() {
    const enumsDir = path.join(process.cwd(), 'src', 'schemas', 'enums');
    if (!fs.existsSync(enumsDir)) {
      this.logger.warn(`Enums directory not found at ${enumsDir}`);
      return;
    }

    const files = fs.readdirSync(enumsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(enumsDir, file), 'utf8');
        const doc: {
          enumName?: string;
          values?: { code: string; remark?: string }[];
          modes?: { highLevelMode?: string; reportingMode: string }[];
        } = JSON.parse(content);
        const name = doc.enumName || file.replace(/\.json$/, '');
        const detailed =
          doc.values?.map((v) => ({ code: v.code, remark: v.remark })) ??
          doc.modes?.map((m) => ({ code: m.reportingMode, remark: m.highLevelMode }));
        const codes = detailed?.map((d) => d.code);
        if (!codes || codes.length === 0) {
          // Better a warning than a silent free-text fallback: an enum file
          // present but unreadable is a packaging mistake, not a design.
          this.logger.warn(`Enum ${name} declares no resolvable codes; leaving it unresolved.`);
          continue;
        }
        this.enums.set(name, codes);
        this.enumDetails.set(name, detailed!);
        this.logger.log(`Loaded enum: ${name} (${codes.length} codes)`);
      } catch (err: any) {
        this.logger.error(`Failed to load enum ${file}: ${err.message}`);
      }
    }
  }

  /**
   * Resolves a curated field's enumRef to its valid codes, or undefined
   * if enumRef isn't a known, generically-resolvable enum.
   */
  resolveEnum(enumRef: string): string[] | undefined {
    return this.enums.get(enumRef);
  }

  /**
   * One enum's codes with their remarks — what a picker needs to show a
   * label rather than a bare code.
   */
  resolveEnumDetailed(enumRef: string): { code: string; remark?: string }[] | undefined {
    return this.enumDetails.get(enumRef);
  }

  private buildTypeBoxSchema(schemaDef: OvdSchema): TSchema {
    const properties: Record<string, TSchema> = {};

    for (const field of schemaDef.fields) {
      let fieldType: TSchema;

      switch (field.type) {
        case 'wholeNumber':
        case 'decimal':
          fieldType = Type.Number();
          break;
        case 'boolean':
          fieldType = Type.Boolean();
          break;
        case 'date':
        case 'time':
        case 'dateTime':
        case 'text':
        case 'enum':
        default:
          fieldType = Type.String();
          if (field.maxLength) {
            fieldType = Type.String({ maxLength: field.maxLength });
          }
          break;
      }

      // Wrap in Optional if not mandatory
      if (field.schemaMandatory) {
        properties[field.name] = fieldType;
      } else {
        properties[field.name] = Type.Optional(fieldType);
      }
    }

    return Type.Object(properties, { additionalProperties: true });
  }

  /**
   * Validates the provided fields against the compiled schema.
   * Throws BadRequestException if validation fails.
   */
  validate(schemaName: string, fields: Record<string, any>) {
    const compiler = this.compilers.get(schemaName);
    const originalSchema = this.originalSchemas.get(schemaName);

    if (!compiler || !originalSchema) {
      throw new InvalidInputError(`Unknown schema: ${schemaName}`);
    }

    const isValid = compiler.Check(fields);
    if (!isValid) {
      const typeboxErrors = [...compiler.Errors(fields)];
      const legacyErrors: string[] = [];

      for (const err of typeboxErrors) {
        // err.path is like "/IMO", we need to strip the leading slash
        const fieldName = err.path.replace(/^\//, '');
        const fieldDef = originalSchema.fields.find(
          (f) => f.name === fieldName,
        );

        if (!fieldDef) {
          legacyErrors.push(`${fieldName}: ${err.message}`);
          continue;
        }

        const label = fieldDef.label || fieldDef.name;

        // Map TypeBox error types to legacy Go error formats
        // Required property missing
        if (err.type === 45) {
          // 45 is ObjectRequiredProperty
          legacyErrors.push(`${label} is required`);
        }
        // Invalid type or format
        else if (
          err.type === 54 ||
          err.type === 53 ||
          err.type === 41 ||
          err.type === 62
        ) {
          // 54 String, 41 Number, 62 Boolean
          switch (fieldDef.type) {
            case 'wholeNumber':
              legacyErrors.push(`${label} must be a whole number`);
              break;
            case 'decimal':
              legacyErrors.push(`${label} must be a number`);
              break;
            case 'boolean':
              legacyErrors.push(`${label} must be true or false`);
              break;
            case 'date':
            case 'time':
            case 'dateTime':
              legacyErrors.push(`${label} must be a date/time string`);
              break;
            case 'text':
            case 'enum':
            default:
              legacyErrors.push(`${label} must be text`);
              break;
          }
        }
        // Max Length exceeded
        else if (err.type === 56) {
          // 56 StringMaxLength
          legacyErrors.push(
            `${label} exceeds maximum length of ${fieldDef.maxLength}`,
          );
        } else {
          // Fallback
          legacyErrors.push(`${label}: ${err.message}`);
        }
      }

      // The field-level errors travel in `details`, which both transports
      // preserve — the report form renders them against individual inputs,
      // so collapsing them to the summary message would leave an officer
      // with "Validation failed" and nothing to act on.
      throw new InvalidInputError('Validation failed', { errors: legacyErrors });
    }
  }

  /**
   * Retrieves the parsed schema definition for dynamic frontend rendering.
   */
  getSchema(schemaName: string): OvdSchema {
    // Ensure the schema name has .json extension for lookup
    const key = schemaName.endsWith('.json')
      ? schemaName
      : `${schemaName}.json`;
    const schema = this.originalSchemas.get(key);

    if (!schema) {
      throw new InvalidInputError(`Schema not found: ${schemaName}`);
    }

    return schema;
  }
}
