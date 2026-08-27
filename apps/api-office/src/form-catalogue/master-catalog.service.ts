import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  formSchemaChecksum,
  formSchemaFields,
  formSchemaVersions,
  formSchemas,
} from '@ovl/database';
import { PlatformDbService, type PublisherDatabase } from '../tenancy/platform-db.service';
import {
  InvalidFormSchemaError,
  diffFields,
  parseFormSchemaDocument,
  projectFields,
  validateFormSchemaDocument,
  type FormSchemaDocument,
} from './form-schema-document';

export interface PublishMasterSchemaInput {
  /** The raw JSON document. schemaName and version are read from inside it. */
  content: string;
  title?: string;
  description?: string;
}

export interface MasterVersionSummary {
  id: string;
  schemaName: string;
  version: string;
  ovdVersion: string | null;
  status: string;
  contentChecksum: string;
  publishedAt: string | null;
  publishedBy: string | null;
  fieldCount: number;
}

/**
 * The master form-schema catalogue: what a platform super admin publishes for
 * every tenant to choose from.
 *
 * Every write goes through `PlatformDbService.asPublisher`, which verifies the
 * caller is a super admin and then assumes the `platform_publisher` role for
 * one transaction. Reads need no elevation — tenants can already SELECT the
 * catalogue, which is exactly the asymmetry the model calls for.
 */
@Injectable()
export class MasterCatalogService {
  private readonly logger = new Logger(MasterCatalogService.name);

  constructor(private readonly platform: PlatformDbService) {}

  /** Every schema in the catalogue, with its latest published version. */
  async listSchemas(): Promise<MasterVersionSummary[]> {
    const rows = await this.platform.db
      .select({
        id: formSchemaVersions.id,
        schemaName: formSchemaVersions.schemaName,
        version: formSchemaVersions.version,
        ovdVersion: formSchemaVersions.ovdVersion,
        status: formSchemaVersions.status,
        contentChecksum: formSchemaVersions.contentChecksum,
        publishedAt: formSchemaVersions.publishedAt,
        publishedBy: formSchemaVersions.publishedBy,
        content: formSchemaVersions.content,
      })
      .from(formSchemaVersions)
      .orderBy(formSchemaVersions.schemaName, desc(formSchemaVersions.publishedAt));

    return rows.map((row) => ({
      id: row.id,
      schemaName: row.schemaName,
      version: row.version,
      ovdVersion: row.ovdVersion,
      status: row.status,
      contentChecksum: row.contentChecksum,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      fieldCount: (row.content as FormSchemaDocument)?.fields?.length ?? 0,
    }));
  }

  /** All versions of one schema, newest first. */
  async listVersions(schemaName: string) {
    return this.platform.db
      .select()
      .from(formSchemaVersions)
      .where(eq(formSchemaVersions.schemaName, schemaName))
      .orderBy(desc(formSchemaVersions.publishedAt));
  }

  async getVersion(id: string) {
    const rows = await this.platform.db
      .select()
      .from(formSchemaVersions)
      .where(eq(formSchemaVersions.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException(`No master schema version ${id}`);
    return rows[0];
  }

  async getLatest(schemaName: string) {
    const rows = await this.platform.db
      .select()
      .from(formSchemaVersions)
      .where(
        and(eq(formSchemaVersions.schemaName, schemaName), eq(formSchemaVersions.status, 'published')),
      )
      .orderBy(desc(formSchemaVersions.publishedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Validates a candidate document and diffs it against what is published,
   * without writing anything.
   *
   * Returns problems as data rather than throwing, so the UI can render them
   * inline next to the upload — the same shape the existing schema-versions
   * preview uses.
   */
  async preview(content: string): Promise<{
    valid: boolean;
    errors: string[];
    schemaName?: string;
    version?: string;
    fieldCount?: number;
    versionExists?: boolean;
    diff?: ReturnType<typeof diffFields> | null;
  }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      return { valid: false, errors: [`not valid JSON: ${(error as Error).message}`] };
    }

    const validation = validateFormSchemaDocument(parsed);
    if (!validation.valid) return { valid: false, errors: validation.errors };

    const document = parsed as FormSchemaDocument;
    const current = await this.getLatest(document.schemaName);

    const existing = await this.platform.db
      .select({ id: formSchemaVersions.id })
      .from(formSchemaVersions)
      .where(
        and(
          eq(formSchemaVersions.schemaName, document.schemaName),
          eq(formSchemaVersions.version, document.version),
        ),
      )
      .limit(1);

    return {
      valid: true,
      errors: [],
      schemaName: document.schemaName,
      version: document.version,
      fieldCount: document.fields.length,
      versionExists: existing.length > 0,
      diff: current
        ? diffFields((current.content as FormSchemaDocument).fields ?? [], document.fields)
        : null,
    };
  }

  /**
   * Publishes a new master version.
   *
   * Refuses to overwrite an existing (schemaName, version) rather than
   * upserting. Published versions are immutable: tenants pin adoptions to a
   * version id and reports record the version they were captured under, so
   * rewriting one would retroactively change what already-collected data
   * means. Shipping a change means shipping a new version number.
   */
  async publish(supertokensUserId: string, input: PublishMasterSchemaInput) {
    let document: FormSchemaDocument;
    try {
      document = parseFormSchemaDocument(input.content);
    } catch (error) {
      if (error instanceof InvalidFormSchemaError) throw new BadRequestException(error.message);
      throw error;
    }

    return this.platform.asPublisher(supertokensUserId, async (db) => {
      await this.upsertSchemaIdentity(db, document, input.title, input.description);

      const clash = await db
        .select({ id: formSchemaVersions.id })
        .from(formSchemaVersions)
        .where(
          and(
            eq(formSchemaVersions.schemaName, document.schemaName),
            eq(formSchemaVersions.version, document.version),
          ),
        )
        .limit(1);

      if (clash.length > 0) {
        throw new ConflictException(
          `${document.schemaName}@${document.version} is already published. ` +
            `Published versions are immutable — publish a new version number instead.`,
        );
      }

      const inserted = await db
        .insert(formSchemaVersions)
        .values({
          schemaName: document.schemaName,
          version: document.version,
          ovdVersion: document.ovdVersion ?? null,
          content: document,
          contentChecksum: formSchemaChecksum(document),
          sections: document.sections ?? [],
          status: 'published',
          publishedAt: new Date().toISOString(),
          publishedBy: supertokensUserId,
        })
        .returning();

      await this.writeFieldProjection(db, inserted[0].id, document);

      this.logger.log(
        `Published master schema ${document.schemaName}@${document.version} ` +
          `(${document.fields.length} fields) by ${supertokensUserId}`,
      );
      return inserted[0];
    });
  }

  /**
   * Hides a version from new adoptions without breaking existing ones.
   *
   * Deprecation rather than deletion, for the same reason versions are
   * immutable: a tenant may be using it right now, and a report captured under
   * it still needs its definition to remain readable.
   */
  async deprecateVersion(supertokensUserId: string, versionId: string) {
    return this.platform.asPublisher(supertokensUserId, async (db) => {
      const updated = await db
        .update(formSchemaVersions)
        .set({ status: 'deprecated' })
        .where(eq(formSchemaVersions.id, versionId))
        .returning();

      if (!updated[0]) throw new NotFoundException(`No master schema version ${versionId}`);
      this.logger.log(`Deprecated master schema version ${versionId} by ${supertokensUserId}`);
      return updated[0];
    });
  }

  /**
   * Seeds a version with no caller behind it, skipping if already present.
   *
   * Used by the curated-catalogue seeder at boot. Goes through
   * `runAsPublisher` rather than `asPublisher` because there is no identity to
   * check — this is the process seeding itself, not a request.
   */
  async seedIfAbsent(document: FormSchemaDocument, title: string): Promise<boolean> {
    return this.platform.runAsPublisher(async (db) => {
      const existing = await db
        .select({ id: formSchemaVersions.id })
        .from(formSchemaVersions)
        .where(
          and(
            eq(formSchemaVersions.schemaName, document.schemaName),
            eq(formSchemaVersions.version, document.version),
          ),
        )
        .limit(1);

      if (existing.length > 0) return false;

      await this.upsertSchemaIdentity(db, document, title);

      const inserted = await db
        .insert(formSchemaVersions)
        .values({
          schemaName: document.schemaName,
          version: document.version,
          ovdVersion: document.ovdVersion ?? null,
          content: document,
          contentChecksum: formSchemaChecksum(document),
          sections: document.sections ?? [],
          status: 'published',
          publishedAt: new Date().toISOString(),
          publishedBy: 'system:curated-seed',
        })
        .returning();

      await this.writeFieldProjection(db, inserted[0].id, document);
      return true;
    });
  }

  private async upsertSchemaIdentity(
    db: PublisherDatabase,
    document: FormSchemaDocument,
    title?: string,
    description?: string,
  ): Promise<void> {
    await db
      .insert(formSchemas)
      .values({
        schemaName: document.schemaName,
        title: title ?? document.schemaName,
        description: description ?? null,
      })
      .onConflictDoUpdate({
        target: formSchemas.schemaName,
        set: { updatedAt: new Date().toISOString(), ...(title ? { title } : {}) },
      });
  }

  /** Rebuilds the queryable row view of a version's fields. */
  private async writeFieldProjection(
    db: PublisherDatabase,
    versionId: string,
    document: FormSchemaDocument,
  ): Promise<void> {
    const fields = projectFields(document);
    if (fields.length === 0) return;

    await db.insert(formSchemaFields).values(
      fields.map((field) => ({
        schemaVersionId: versionId,
        ordinal: field.ordinal,
        name: field.name,
        label: field.label,
        type: field.type,
        unit: field.unit,
        maxLength: field.maxLength,
        enumRef: field.enumRef,
        schemaMandatory: field.schemaMandatory,
        mandatoryNote: field.mandatoryNote,
        relevance: field.relevance,
        section: field.section,
        appliesToEvents: field.appliesToEvents,
        description: field.description,
        attributes: field.attributes,
      })),
    );
  }
}
