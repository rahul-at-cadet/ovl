import { Injectable, Inject, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { DATABASE_CONNECTION } from '../../database/database.module';
import { SchemaField, diffSchemaFields, SchemaDiff } from '../logic/fieldPolicy';

const ajv = new Ajv();

export interface PublishSchemaInput {
  schemaName: string;
  version: string;
  source: string;
  content: string;
}

export interface PreviewResult {
  valid: boolean;
  error?: string;
  parsedName?: string;
  parsedVersion?: string;
  diff?: SchemaDiff | null;
}

@Injectable()
export class SchemaVersionsService implements OnModuleInit {
  private readonly logger = new Logger(SchemaVersionsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Ports ovl/office/main.go's seedCuratedSchemas: office is meant to be
   * the authoritative source for the curated OVD schema set (vessel only
   * ever embedded its own copy as a bootstrapping convenience before
   * office->vessel config sync existed), but on a fresh database nothing
   * has ever published them, so the schema picker in Configuration is
   * empty. Idempotent — skips any schema name that already has a
   * published version — so running this on every boot is safe and never
   * clobbers a real admin-uploaded version.
   */
  async onModuleInit() {
    const curatedDir = path.join(process.cwd(), 'src', 'schemas');
    if (!fs.existsSync(curatedDir)) {
      this.logger.warn(`Curated schemas directory not found at ${curatedDir}`);
      return;
    }
    const files = fs.readdirSync(curatedDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(curatedDir, file), 'utf-8');
        const parsed = JSON.parse(content);
        if (!parsed.schemaName || !parsed.version) continue;
        const existing = await this.getLatest(parsed.schemaName);
        if (existing) continue;
        await this.publish({
          schemaName: parsed.schemaName,
          version: parsed.version,
          source: 'project-curated',
          content,
        });
        this.logger.log(`Seeded curated schema ${parsed.schemaName}@${parsed.version}`);
      } catch (e: any) {
        this.logger.error(`Failed to seed curated schema ${file}: ${e.message}`);
      }
    }
  }

  async list() {
    const results = await this.db
      .select()
      .from(schema.schemaVersions)
      .orderBy(desc(schema.schemaVersions.publishedAt));
    return results.map((r) => ({
      id: r.id,
      schemaName: r.schemaName,
      version: r.version,
      source: r.source,
      publishedAt: r.publishedAt,
      publishedBy: r.publishedBy,
      content: r.content.toString('utf-8'),
    }));
  }

  async getLatest(schemaName: string) {
    const rows = await this.db
      .select()
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaName, schemaName))
      .orderBy(desc(schema.schemaVersions.publishedAt))
      .limit(1);
    return rows[0];
  }

  /** Fields parsed out of the latest published version's content, or []. */
  async getLatestFields(schemaName: string): Promise<{ fields: SchemaField[]; version: string } | null> {
    const latest = await this.getLatest(schemaName);
    if (!latest) return null;
    const parsed = this.parseContent(latest.content);
    return { fields: parsed.fields ?? [], version: latest.version };
  }

  private parseContent(content: Buffer): { fields?: SchemaField[]; eventTypes?: string[] } {
    try {
      return JSON.parse(content.toString('utf-8'));
    } catch {
      return { fields: [], eventTypes: [] };
    }
  }

  /**
   * Validates + diffs against the current latest version for this schema
   * name. Mirrors handlePreviewSchemaUpload: validation/parse failure comes
   * back as a normal `{valid:false, error}` result, not a thrown error, so
   * the UI can render it inline.
   */
  async preview(schemaName: string, content: string): Promise<PreviewResult> {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e: any) {
      return { valid: false, error: `invalid JSON: ${e.message}` };
    }

    if (!ajv.validateSchema(parsed)) {
      return { valid: false, error: 'invalid JSON Schema according to meta-schema' };
    }
    if (!Array.isArray(parsed.fields) || parsed.fields.length === 0) {
      return { valid: false, error: 'schema must declare at least one field' };
    }

    const current = await this.getLatest(schemaName);
    let diff: SchemaDiff | null = null;
    if (current) {
      const currentParsed = this.parseContent(current.content);
      diff = diffSchemaFields(currentParsed.fields ?? [], parsed.fields as SchemaField[]);
    }

    return {
      valid: true,
      parsedName: parsed.schemaName,
      parsedVersion: parsed.version,
      diff,
    };
  }

  async publish(input: PublishSchemaInput) {
    let parsed: any;
    try {
      parsed = JSON.parse(input.content);
    } catch {
      throw new BadRequestException('Invalid JSON format');
    }

    if (!ajv.validateSchema(parsed)) {
      throw new BadRequestException('Invalid JSON Schema according to meta-schema');
    }

    const newSchema = await this.db
      .insert(schema.schemaVersions)
      .values({
        schemaName: input.schemaName,
        version: input.version,
        source: input.source,
        content: Buffer.from(input.content, 'utf-8'),
        publishedAt: new Date().toISOString(),
        publishedBy: 'System Admin',
      })
      .returning();

    return newSchema[0];
  }
}
