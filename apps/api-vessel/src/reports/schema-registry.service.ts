import {
  Injectable,
  OnModuleInit,
  Logger,
  BadRequestException,
} from '@nestjs/common';
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

  onModuleInit() {
    this.loadSchemas();
    this.loadEnums();
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
  // at "fuel-types") — ported from the original's pkg/schema.ResolveEnum,
  // same {"values":[{"code": "..."}, ...]} shape, code-only resolution.
  // An enumRef with no matching file here (e.g. "offshore-modes", which
  // uses an incompatible document shape) is left unresolved and the
  // frontend falls back to unrestricted text entry, matching the
  // original's behavior for enums with no generic resolver.
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
        const doc: { enumName?: string; values: { code: string }[] } = JSON.parse(content);
        const name = doc.enumName || file.replace(/\.json$/, '');
        this.enums.set(name, doc.values.map((v) => v.code));
        this.logger.log(`Loaded enum: ${name} (${doc.values.length} codes)`);
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
