import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  formSchemaAdoptions,
  formSchemaChecksum,
  tenantFormSchemaFields,
  tenantFormSchemaVersions,
} from '@ovl/database';
import { TenantDbService, type TenantDatabase } from '../tenancy/tenant-db.service';
import { currentTenant } from '../tenancy/tenant-context';
import { MasterCatalogService } from './master-catalog.service';
import {
  InvalidFormSchemaError,
  diffFields,
  parseFormSchemaDocument,
  projectFields,
  type FormSchemaDocument,
} from './form-schema-document';

/** What a tenant actually uses for one schema name, wherever it came from. */
export interface EffectiveSchema {
  schemaName: string;
  version: string;
  source: 'master' | 'tenant';
  origin: 'master' | 'own' | 'fork';
  contentChecksum: string;
  content: FormSchemaDocument;
  /** Set when the tenant is on master and a newer master version exists. */
  upgradeAvailable?: { version: string; versionId: string } | null;
}

export interface CatalogueEntry {
  schemaName: string;
  title: string;
  masterVersion: string | null;
  masterVersionId: string | null;
  adopted: boolean;
  adoptedSource: 'master' | 'tenant' | null;
  adoptedVersion: string | null;
  /** True when the adopted tenant version is a fork of a master one. */
  isFork: boolean;
  /** Master has moved on since this tenant adopted or forked. */
  upgradeAvailable: boolean;
}

/**
 * A tenant's view of the form-schema catalogue: what it can adopt, what it has
 * adopted, and what it has changed.
 *
 * The three operations that matter are `adoptMaster`, `fork` and `publishOwn`.
 * A tenant never edits a master schema — it cannot, since its role holds only
 * SELECT on `platform` — so "edit this master schema" is expressed as fork,
 * change the copy, adopt the copy.
 */
@Injectable()
export class TenantCatalogService {
  private readonly logger = new Logger(TenantCatalogService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly master: MasterCatalogService,
  ) {}

  /**
   * The catalogue as this tenant sees it: every master schema, annotated with
   * whether this tenant has taken it and whether it has diverged.
   */
  async browse(): Promise<CatalogueEntry[]> {
    return this.browseWith(
      await this.tenantDb.withTenant(
        async (db) => ({
          adoptions: await db.select().from(formSchemaAdoptions),
          versions: await db.select().from(tenantFormSchemaVersions),
        }),
        { readOnly: true },
      ),
    );
  }

  /**
   * The master catalogue with no tenant's adoption state layered on it.
   *
   * For a platform super admin who has selected no tenant. They sit above
   * every customer, so "the version your fleet uses" has no answer for them —
   * but *what the platform publishes* very much does, and returning nothing
   * made the screen claim the platform had published nothing at all, which
   * was false while five schemas sat in the catalogue.
   *
   * Everything comes back unadopted, because adoption is a tenant's own act
   * and there is no tenant here to have made it.
   */
  async browsePlatform(): Promise<CatalogueEntry[]> {
    return this.browseWith({ adoptions: [], versions: [] });
  }

  private async browseWith({
    adoptions,
    versions,
  }: {
    adoptions: Array<typeof formSchemaAdoptions.$inferSelect>;
    versions: Array<typeof tenantFormSchemaVersions.$inferSelect>;
  }): Promise<CatalogueEntry[]> {
    const masterSchemas = await this.master.listSchemas();
    const latestByName = new Map<string, (typeof masterSchemas)[number]>();
    for (const row of masterSchemas) {
      if (!latestByName.has(row.schemaName)) latestByName.set(row.schemaName, row);
    }

    const versionById = new Map(versions.map((v) => [v.id, v]));
    const adoptionByName = new Map(adoptions.map((a) => [a.schemaName, a]));

    const names = new Set([...latestByName.keys(), ...adoptionByName.keys()]);

    return [...names].sort().map((schemaName) => {
      const masterLatest = latestByName.get(schemaName) ?? null;
      const adoption = adoptionByName.get(schemaName) ?? null;
      const tenantVersion = adoption?.tenantVersionId
        ? versionById.get(adoption.tenantVersionId)
        : undefined;

      // "Upgrade available" means something different in each case. On master:
      // a newer master version exists. On a fork: master has moved past the
      // version this fork was taken from, so the tenant may want to re-fork.
      let upgradeAvailable = false;
      if (adoption?.source === 'master' && masterLatest) {
        upgradeAvailable = adoption.masterVersionId !== masterLatest.id;
      } else if (tenantVersion?.origin === 'fork' && masterLatest) {
        upgradeAvailable = tenantVersion.forkedFromVersionId !== masterLatest.id;
      }

      return {
        schemaName,
        title: schemaName,
        masterVersion: masterLatest?.version ?? null,
        masterVersionId: masterLatest?.id ?? null,
        adopted: adoption !== null,
        adoptedSource: (adoption?.source as 'master' | 'tenant' | undefined) ?? null,
        adoptedVersion: adoption
          ? adoption.source === 'master'
            ? adoption.masterVersion
            : (tenantVersion?.version ?? null)
          : null,
        isFork: tenantVersion?.origin === 'fork',
        upgradeAvailable,
      };
    });
  }

  /**
   * Resolves what this tenant actually uses for a schema name.
   *
   * This is what the vessel sync and the report renderer consume. A schema
   * with no adoption row resolves to null rather than falling back to master —
   * the absence of an implicit default is the whole point of the opt-in, since
   * a fallback would let a super admin change what a tenant's crews see
   * without the tenant ever agreeing to it.
   */
  async resolve(schemaName: string): Promise<EffectiveSchema | null> {
    const adoption = await this.tenantDb.withTenant(
      async (db) => {
        const rows = await db
          .select()
          .from(formSchemaAdoptions)
          .where(eq(formSchemaAdoptions.schemaName, schemaName))
          .limit(1);
        return rows[0] ?? null;
      },
      { readOnly: true },
    );

    if (!adoption) return null;

    if (adoption.source === 'master') {
      const version = await this.master.getVersion(adoption.masterVersionId!);
      const latest = await this.master.getLatest(schemaName);
      return {
        schemaName,
        version: version.version,
        source: 'master',
        origin: 'master',
        contentChecksum: version.contentChecksum,
        content: version.content as FormSchemaDocument,
        upgradeAvailable:
          latest && latest.id !== version.id
            ? { version: latest.version, versionId: latest.id }
            : null,
      };
    }

    const version = await this.tenantDb.withTenant(
      async (db) => {
        const rows = await db
          .select()
          .from(tenantFormSchemaVersions)
          .where(eq(tenantFormSchemaVersions.id, adoption.tenantVersionId!))
          .limit(1);
        return rows[0] ?? null;
      },
      { readOnly: true },
    );

    if (!version) {
      // The adoption FK is ON DELETE RESTRICT, so this should be unreachable.
      throw new NotFoundException(
        `Adoption for ${schemaName} points at a missing tenant version — the catalogue is inconsistent.`,
      );
    }

    return {
      schemaName,
      version: version.version,
      source: 'tenant',
      origin: version.origin as 'own' | 'fork',
      contentChecksum: version.contentChecksum,
      content: version.content as FormSchemaDocument,
    };
  }

  /** Everything this tenant has adopted, resolved. For the vessel sync. */
  async resolveAll(): Promise<EffectiveSchema[]> {
    const adoptions = await this.tenantDb.withTenant(
      (db) => db.select({ schemaName: formSchemaAdoptions.schemaName }).from(formSchemaAdoptions),
      { readOnly: true },
    );

    const resolved = await Promise.all(adoptions.map((a) => this.resolve(a.schemaName)));
    return resolved.filter((r): r is EffectiveSchema => r !== null);
  }

  /** Takes a master version as-is. The tenant's opt-in. */
  async adoptMaster(masterVersionId: string, actor: string): Promise<CatalogueEntry[]> {
    const version = await this.master.getVersion(masterVersionId);

    if (version.status !== 'published') {
      throw new BadRequestException(
        `Cannot adopt ${version.schemaName}@${version.version}: it is ${version.status}.`,
      );
    }

    await this.tenantDb.withTenant(async (db) => {
      await db
        .insert(formSchemaAdoptions)
        .values({
          schemaName: version.schemaName,
          source: 'master',
          masterVersionId: version.id,
          masterVersion: version.version,
          masterChecksum: version.contentChecksum,
          tenantVersionId: null,
          adoptedBy: actor,
        })
        .onConflictDoUpdate({
          target: formSchemaAdoptions.schemaName,
          set: {
            source: 'master',
            masterVersionId: version.id,
            masterVersion: version.version,
            masterChecksum: version.contentChecksum,
            // Cleared explicitly: the one-source CHECK constraint rejects a row
            // carrying both, so leaving a stale tenant id here would make the
            // update fail rather than quietly produce an ambiguous adoption.
            tenantVersionId: null,
            adoptedAt: new Date().toISOString(),
            adoptedBy: actor,
          },
        });
    });

    this.logger.log(
      `Tenant ${currentTenant().slug} adopted master ${version.schemaName}@${version.version}`,
    );
    return this.browse();
  }

  /** Stops using a schema entirely. */
  async unadopt(schemaName: string): Promise<CatalogueEntry[]> {
    await this.tenantDb.withTenant(async (db) => {
      await db.delete(formSchemaAdoptions).where(eq(formSchemaAdoptions.schemaName, schemaName));
    });
    return this.browse();
  }

  /**
   * Copies a master version into this tenant so it can be changed.
   *
   * The lineage columns are the reason forking is a first-class operation
   * rather than "download the JSON and re-upload it": recording which master
   * version this came from, and its checksum, is what later answers whether a
   * master upgrade collides with the tenant's edits.
   *
   * The copy is created as a draft and does *not* change the adoption. A
   * tenant forks, edits, then publishes — so a half-finished edit never
   * reaches a vessel.
   */
  async fork(masterVersionId: string, newVersion: string, actor: string) {
    const source = await this.master.getVersion(masterVersionId);
    const document = source.content as FormSchemaDocument;

    return this.tenantDb.withTenant(async (db) => {
      await this.assertVersionFree(db, source.schemaName, newVersion);

      const forked: FormSchemaDocument = { ...document, version: newVersion };

      const inserted = await db
        .insert(tenantFormSchemaVersions)
        .values({
          schemaName: source.schemaName,
          version: newVersion,
          ovdVersion: source.ovdVersion,
          origin: 'fork',
          forkedFromVersionId: source.id,
          forkedFromVersion: source.version,
          forkedFromChecksum: source.contentChecksum,
          content: forked,
          contentChecksum: formSchemaChecksum(forked),
          sections: source.sections,
          status: 'draft',
          createdBy: actor,
        })
        .returning();

      await this.writeFieldProjection(db, inserted[0].id, forked);

      this.logger.log(
        `Tenant ${currentTenant().slug} forked ${source.schemaName}@${source.version} ` +
          `as ${newVersion}`,
      );
      return inserted[0];
    });
  }

  /** Uploads a schema this tenant authored itself, as a draft. */
  async createOwn(content: string, actor: string) {
    let document: FormSchemaDocument;
    try {
      document = parseFormSchemaDocument(content);
    } catch (error) {
      if (error instanceof InvalidFormSchemaError) throw new BadRequestException(error.message);
      throw error;
    }

    return this.tenantDb.withTenant(async (db) => {
      await this.assertVersionFree(db, document.schemaName, document.version);

      const inserted = await db
        .insert(tenantFormSchemaVersions)
        .values({
          schemaName: document.schemaName,
          version: document.version,
          ovdVersion: document.ovdVersion ?? null,
          origin: 'own',
          content: document,
          contentChecksum: formSchemaChecksum(document),
          sections: document.sections ?? [],
          status: 'draft',
          createdBy: actor,
        })
        .returning();

      await this.writeFieldProjection(db, inserted[0].id, document);
      return inserted[0];
    });
  }

  /**
   * Replaces a draft's content. Drafts are the only mutable thing here —
   * published versions are immutable on both sides of the model.
   */
  async updateDraft(versionId: string, content: string) {
    let document: FormSchemaDocument;
    try {
      document = parseFormSchemaDocument(content);
    } catch (error) {
      if (error instanceof InvalidFormSchemaError) throw new BadRequestException(error.message);
      throw error;
    }

    return this.tenantDb.withTenant(async (db) => {
      const existing = await this.requireVersion(db, versionId);
      if (existing.status !== 'draft') {
        throw new ConflictException(
          `${existing.schemaName}@${existing.version} is ${existing.status} and cannot be edited. ` +
            `Create a new version instead.`,
        );
      }

      const updated = await db
        .update(tenantFormSchemaVersions)
        .set({
          content: document,
          contentChecksum: formSchemaChecksum(document),
          sections: document.sections ?? [],
          ovdVersion: document.ovdVersion ?? null,
        })
        .where(eq(tenantFormSchemaVersions.id, versionId))
        .returning();

      await db
        .delete(tenantFormSchemaFields)
        .where(eq(tenantFormSchemaFields.schemaVersionId, versionId));
      await this.writeFieldProjection(db, versionId, document);

      return updated[0];
    });
  }

  /** Publishes a draft and points the adoption at it. */
  async publishOwn(versionId: string, actor: string): Promise<CatalogueEntry[]> {
    await this.tenantDb.withTenant(async (db) => {
      const version = await this.requireVersion(db, versionId);

      if (version.status === 'deprecated') {
        throw new ConflictException(`${version.schemaName}@${version.version} is deprecated.`);
      }

      if (version.status === 'draft') {
        await db
          .update(tenantFormSchemaVersions)
          .set({
            status: 'published',
            publishedAt: new Date().toISOString(),
            publishedBy: actor,
          })
          .where(eq(tenantFormSchemaVersions.id, versionId));
      }

      await db
        .insert(formSchemaAdoptions)
        .values({
          schemaName: version.schemaName,
          source: 'tenant',
          tenantVersionId: versionId,
          masterVersionId: null,
          masterVersion: null,
          masterChecksum: null,
          adoptedBy: actor,
        })
        .onConflictDoUpdate({
          target: formSchemaAdoptions.schemaName,
          set: {
            source: 'tenant',
            tenantVersionId: versionId,
            masterVersionId: null,
            masterVersion: null,
            masterChecksum: null,
            adoptedAt: new Date().toISOString(),
            adoptedBy: actor,
          },
        });
    });

    return this.browse();
  }

  /** Versions this tenant owns, for one schema name or all of them. */
  async listOwnVersions(schemaName?: string) {
    return this.tenantDb.withTenant(
      (db) =>
        schemaName
          ? db
              .select()
              .from(tenantFormSchemaVersions)
              .where(eq(tenantFormSchemaVersions.schemaName, schemaName))
              .orderBy(desc(tenantFormSchemaVersions.createdAt))
          : db.select().from(tenantFormSchemaVersions).orderBy(desc(tenantFormSchemaVersions.createdAt)),
      { readOnly: true },
    );
  }

  /**
   * What a tenant's fork changed relative to the master version it came from,
   * and what master has changed since.
   *
   * The two diffs together are the upgrade decision: if they touch disjoint
   * fields the upgrade is mechanical, and if they overlap it needs a human.
   */
  async forkDivergence(versionId: string) {
    const version = await this.tenantDb.withTenant(
      (db) => this.requireVersion(db, versionId),
      { readOnly: true },
    );

    if (version.origin !== 'fork' || !version.forkedFromVersionId) {
      throw new BadRequestException(`${version.schemaName}@${version.version} is not a fork.`);
    }

    const forkedFrom = await this.master.getVersion(version.forkedFromVersionId);
    const masterLatest = await this.master.getLatest(version.schemaName);

    const forkedFromDoc = forkedFrom.content as FormSchemaDocument;
    const ourDoc = version.content as FormSchemaDocument;

    return {
      forkedFrom: { version: forkedFrom.version, id: forkedFrom.id },
      masterLatest: masterLatest ? { version: masterLatest.version, id: masterLatest.id } : null,
      ourChanges: diffFields(forkedFromDoc.fields ?? [], ourDoc.fields ?? []),
      masterChanges: masterLatest
        ? diffFields(forkedFromDoc.fields ?? [], (masterLatest.content as FormSchemaDocument).fields ?? [])
        : null,
    };
  }

  private async requireVersion(db: TenantDatabase, versionId: string) {
    const rows = await db
      .select()
      .from(tenantFormSchemaVersions)
      .where(eq(tenantFormSchemaVersions.id, versionId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException(`No tenant schema version ${versionId}`);
    return rows[0];
  }

  private async assertVersionFree(db: TenantDatabase, schemaName: string, version: string) {
    const clash = await db
      .select({ id: tenantFormSchemaVersions.id })
      .from(tenantFormSchemaVersions)
      .where(
        and(
          eq(tenantFormSchemaVersions.schemaName, schemaName),
          eq(tenantFormSchemaVersions.version, version),
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw new ConflictException(`${schemaName}@${version} already exists for this tenant.`);
    }
  }

  private async writeFieldProjection(
    db: TenantDatabase,
    versionId: string,
    document: FormSchemaDocument,
  ): Promise<void> {
    const fields = projectFields(document);
    if (fields.length === 0) return;

    await db.insert(tenantFormSchemaFields).values(
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
