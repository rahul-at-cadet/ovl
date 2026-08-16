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

  onModuleInit() {
    this.loadSchemas();
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
