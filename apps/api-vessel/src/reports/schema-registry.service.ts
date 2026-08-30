import {
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { SchemaSyncService } from './schema-sync.service';
import * as fs from 'fs';
import * as path from 'path';
import { Type, TSchema } from '@sinclair/typebox';
import { TypeCompiler, TypeCheck } from '@sinclair/typebox/compiler';

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

  constructor(private readonly schemaSync: SchemaSyncService) {}

  async onModuleInit() {
    await this.reload();
    this.loadEnums();
  }

  /**
   * Rebuilds the compiled schema set from whatever the vessel currently holds.
   *
   * Synced schemas win; the bundled JSON files are a bootstrap fallback for a
   * vessel that has never reached shore. That ordering is the whole point of
   * this change — before it, the files were the only source, so an office could
   * publish a new version and the vessel would keep rendering whatever was
   * baked into its image, indefinitely and silently.
   *
   * Called again after every successful sync, so a newly adopted or newly
   * forked schema takes effect without restarting the vessel.
   */
  async reload(): Promise<void> {
    let synced: Array<{ schemaName: string; version: string; document: unknown }> = [];
    try {
      synced = await this.schemaSync.list();
    } catch (error) {
      // A vessel whose local store is unreadable must still come up on its
      // bundled schemas rather than refusing to start with no forms at all.
      this.logger.error(
        `Could not read synced schemas; falling back to bundled files: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.compilers.clear();
    this.originalSchemas.clear();

    if (synced.length > 0) {
      for (const row of synced) {
        this.compile(row.document as OvdSchema, `synced ${row.schemaName}@${row.version}`);
      }
      this.logger.log(`Loaded ${this.compilers.size} schema(s) synced from shore.`);
      return;
    }

    this.logger.warn('No schemas synced from shore yet; using the bundled copies.');
    this.loadSchemas();
  }

  /** Compiles one document into the validator set, or logs and skips it. */
  private compile(schemaDef: OvdSchema, label: string): void {
    try {
      const key = schemaDef.schemaName + '.json';
      this.compilers.set(key, TypeCompiler.Compile(this.buildTypeBoxSchema(schemaDef)));
      this.originalSchemas.set(key, schemaDef);
    } catch (err: any) {
      // One unusable schema must not take the others down with it — the rest
      // of the fleet's forms still have to work.
      this.logger.error(`Failed to compile ${label}: ${err.message}`);
    }
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
          values?: { code: string }[];
          modes?: { highLevelMode?: string; reportingMode: string }[];
        } = JSON.parse(content);
        const name = doc.enumName || file.replace(/\.json$/, '');
        const codes = doc.values?.map((v) => v.code) ?? doc.modes?.map((m) => m.reportingMode);
        if (!codes || codes.length === 0) {
          // Better a warning than a silent free-text fallback: an enum file
          // present but unreadable is a packaging mistake, not a design.
          this.logger.warn(`Enum ${name} declares no resolvable codes; leaving it unresolved.`);
          continue;
        }
        this.enums.set(name, codes);
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
      throw new BadRequestException(`Unknown schema: ${schemaName}`);
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

      // Return array of legacy formatted errors
      throw new BadRequestException({
        message: 'Validation failed',
        errors: legacyErrors,
      });
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
      throw new BadRequestException(`Schema not found: ${schemaName}`);
    }

    return schema;
  }
}
