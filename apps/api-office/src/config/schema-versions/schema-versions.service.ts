import { Injectable, Inject, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, asc, gt } from 'drizzle-orm';
import * as schema from '@ovl/database';
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { DATABASE_CONNECTION } from '../../database/database.module';
import { toIso } from '../../common/iso-time';
import { SchemaField, diffSchemaFields, SchemaDiff } from '../logic/fieldPolicy';
import { InvalidInputError } from '../../common/app-error';

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
    const curatedDir = this.schemasDir();
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

  /**
   * Every version published after `sinceCursor`, oldest first, for the
   * vessel sync stream — ports ovl/office/store.ListSchemaVersionsSince,
   * which office/syncservice.pullSchemaVersions feeds into PullInbox.
   *
   * Cursor-based rather than "send the current set every time": these
   * documents are tens of kilobytes each and a vessel checks in every
   * thirty seconds over a satellite link, so a ship that is already
   * up to date must transfer nothing at all.
   *
   * `cursor` is a bigint identity column and arrives as a JS number here;
   * it crosses the wire as a string, the same way the chat and remark
   * cursors already do, so no precision is lost at the boundary.
   */
  async listSince(sinceCursor: number, limit = 25) {
    const rows = await this.db
      .select()
      .from(schema.schemaVersions)
      .where(gt(schema.schemaVersions.cursor, sinceCursor))
      .orderBy(asc(schema.schemaVersions.cursor))
      // Bounded so a vessel meeting an office with a long publishing
      // history catches up over several cycles instead of trying to pull
      // the whole archive down one satellite pass.
      .limit(limit);
    return rows.map((r) => ({
      schemaName: r.schemaName,
      version: r.version,
      source: r.source,
      content: r.content.toString('utf-8'),
      // Normalised, not passed through. Drizzle's string mode hands back
      // Postgres's own rendering ("2026-09-03 05:49:46.971+00"), and the
      // vessel stores this in a column its schema documents as RFC3339
      // and then picks the newest version by ordering on it as a string.
      // A store holding both forms would sort them against each other
      // rather than chronologically — 'T' sorts after a space — so a
      // vessel could quietly settle on the wrong "latest" schema.
      publishedAt: new Date(r.publishedAt).toISOString(),
      cursor: String(r.cursor ?? 0),
    }));
  }

  /**
   * One schema name's full version history, newest first — ports
   * store.ListSchemaVersionsForName behind
   * handleListSchemaVersionHistory.
   *
   * `list()` only ever surfaced the newest of each name, so the
   * Schemas screen showed what is current with no way to see what
   * preceded it. A published version is immutable and reports were
   * validated against whichever was in force at the time, so the
   * history is the only thing that explains an older report.
   */
  async history(schemaName: string) {
    const rows = await this.db
      .select({
        id: schema.schemaVersions.id,
        schemaName: schema.schemaVersions.schemaName,
        version: schema.schemaVersions.version,
        source: schema.schemaVersions.source,
        publishedAt: schema.schemaVersions.publishedAt,
        publishedBy: schema.schemaVersions.publishedBy,
        content: schema.schemaVersions.content,
      })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaName, schemaName))
      .orderBy(desc(schema.schemaVersions.publishedAt));

    return rows.map((r) => {
      const parsed = this.parseContent(r.content);
      return {
        id: r.id,
        schemaName: r.schemaName,
        version: r.version,
        source: r.source,
        publishedAt: toIso(r.publishedAt),
        publishedBy: r.publishedBy,
        // A count rather than the whole document: the history is a list
        // to scan, and shipping five 200 KB schemas to render it would
        // be most of a megabyte for one screen.
        fieldCount: parsed.fields?.length ?? 0,
        sizeBytes: r.content.length,
      };
    });
  }

  /**
   * One specific published version, parsed — the diff view's other half.
   * Returns null rather than throwing so the caller can distinguish a
   * missing version from a failure.
   */
  async getVersion(schemaName: string, version: string) {
    const [row] = await this.db
      .select()
      .from(schema.schemaVersions)
      .where(and(eq(schema.schemaVersions.schemaName, schemaName), eq(schema.schemaVersions.version, version)))
      .limit(1);
    if (!row) return null;
    const parsed = this.parseContent(row.content);
    return {
      schemaName: row.schemaName,
      version: row.version,
      source: row.source,
      publishedAt: toIso(row.publishedAt),
      publishedBy: row.publishedBy,
      fields: parsed.fields ?? [],
      eventTypes: parsed.eventTypes ?? [],
      content: row.content.toString('utf-8'),
    };
  }

  /**
   * The exact bytes that were uploaded, for the download route — ports
   * handleDownloadSchemaVersion. Verbatim rather than re-serialised:
   * a published version is immutable, and re-encoding it would hand back
   * a document that differs from the one whose hash and formatting an
   * operator may be comparing against.
   */
  async getVersionBytes(schemaName: string, version: string): Promise<Buffer | null> {
    const [row] = await this.db
      .select({ content: schema.schemaVersions.content })
      .from(schema.schemaVersions)
      .where(and(eq(schema.schemaVersions.schemaName, schemaName), eq(schema.schemaVersions.version, version)))
      .limit(1);
    return row ? row.content : null;
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

  /**
   * Resolves an `enumRef` to its controlled vocabulary — ports
   * schema/enums.go's ResolveEnum.
   *
   * The allowlist is the original's, verbatim: a schema may only point at
   * these seven files, so a malformed or hostile enumRef cannot be used
   * to read arbitrary JSON off disk. offshore-modes ships alongside them
   * but is deliberately excluded there, and is excluded here too — its
   * file has a different shape and the original refuses to resolve it.
   *
   * Codes stay in file order: the vocabulary is authored in a meaningful
   * sequence and re-sorting it alphabetically would scramble that.
   */
  private static readonly ENUM_ALLOWLIST = new Set([
    'event-types',
    'fuel-types',
    'incoterms',
    'charter-types',
    'port-call-purposes',
    'operational-modes',
    'voyage-types',
  ]);

  private readonly enumCache = new Map<string, { code: string; label: string }[]>();

  getEnum(enumRef: string): { code: string; label: string }[] {
    if (!SchemaVersionsService.ENUM_ALLOWLIST.has(enumRef)) return [];
    const cached = this.enumCache.get(enumRef);
    if (cached) return cached;

    const file = path.join(this.schemasDir(), 'enums', `${enumRef}.json`);
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        values?: { code?: string; label?: string }[];
      };
      const values = (doc.values ?? [])
        .filter((v): v is { code: string; label?: string } => typeof v.code === 'string')
        .map((v) => ({ code: v.code, label: v.label ?? v.code }));
      this.enumCache.set(enumRef, values);
      return values;
    } catch {
      // A missing or unreadable vocabulary degrades the field to free
      // text rather than failing the whole form.
      return [];
    }
  }

  /**
   * Locates the bundled `src/schemas` directory.
   *
   * Both call sites previously assumed process.cwd() is the app root,
   * which holds under Docker (WORKDIR is the app) but not when the built
   * server is started from the repo root — there the curated-schema seed
   * silently found nothing and logged a warning nobody was watching for.
   * Falling back to a path derived from this module's own location makes
   * it independent of how the process was launched.
   */
  private schemasDir(): string {
    const candidates = [
      path.join(process.cwd(), 'src', 'schemas'),
      // dist/config/schema-versions -> the app root
      path.resolve(__dirname, '..', '..', '..', 'src', 'schemas'),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
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
      throw new InvalidInputError('Invalid JSON format');
    }

    if (!ajv.validateSchema(parsed)) {
      throw new InvalidInputError('Invalid JSON Schema according to meta-schema');
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
