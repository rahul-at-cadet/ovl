import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool, escapeIdentifier, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ADMIN_PG_POOL } from './tenancy.constants';
import { TenantRegistryService, type TenantDescriptor } from './tenant-registry.service';
import { ProvisioningDisabledError } from './tenant-provisioning.service';
import { assertValidTenantRoleName, assertValidTenantSchemaName } from './tenant-identifiers';

export interface TenantMigration {
  /** The numeric filename prefix, e.g. "0001". Recorded in platform.tenant_migrations. */
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface TenantMigrationStatus {
  slug: string;
  applied: string[];
  pending: string[];
  /** Applied versions whose file no longer matches what was recorded. */
  drifted: string[];
}

export interface FanOutResult {
  slug: string;
  applied: string[];
  error?: string;
}

export class MigrationChecksumMismatchError extends Error {
  constructor(slug: string, version: string) {
    super(
      `Tenant ${slug} already applied migration ${version}, but the file has changed since. ` +
        `An applied migration must never be edited — the recorded state would no longer ` +
        `describe the schema. Add a new migration instead.`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

/**
 * Applies schema changes across every tenant schema.
 *
 * Schema-per-tenant trades one migration for N, and the interesting part is not
 * the loop — it is what happens when the loop dies half way through. Each
 * tenant is migrated in its own transaction and its progress recorded per
 * (tenant, version), so a run that fails on tenant 40 of 200 leaves 39 tenants
 * correctly migrated and is resumed rather than restarted.
 *
 * That also means a fan-out is NOT atomic across tenants: a failed run leaves
 * the fleet on mixed versions, all of them internally consistent. Migrations
 * should therefore be additive wherever possible, so a partially-migrated fleet
 * keeps working.
 *
 * Runs on the elevated pool. Applying DDL and writing the migration ledger both
 * need privileges the serving role deliberately lacks.
 */
@Injectable()
export class TenantMigrationRunnerService {
  private readonly logger = new Logger(TenantMigrationRunnerService.name);
  private cached: TenantMigration[] | null = null;

  constructor(
    @Optional() @Inject(ADMIN_PG_POOL) private readonly adminPool: Pool | null,
    private readonly registry: TenantRegistryService,
  ) {}

  /**
   * Every migration on disk, in filename order.
   *
   * Order is lexicographic on the zero-padded numeric prefix, which is why the
   * prefix is padded: `10_x.sql` sorting before `9_x.sql` would apply them out
   * of order and the failure would look like a broken migration rather than a
   * naming mistake.
   */
  migrations(): TenantMigration[] {
    if (this.cached) return this.cached;

    const dir = this.migrationsDir();
    if (!existsSync(dir)) {
      this.logger.warn(`No tenant migrations directory at ${dir}`);
      this.cached = [];
      return this.cached;
    }

    this.cached = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((filename) => {
        const sql = readFileSync(join(dir, filename), 'utf8');
        const version = filename.split('_')[0];
        if (!/^\d+$/.test(version)) {
          throw new Error(
            `Tenant migration ${filename} must start with a numeric version prefix, e.g. 0002_add_x.sql`,
          );
        }
        return {
          version,
          filename,
          sql,
          checksum: `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`,
        };
      });

    return this.cached;
  }

  /** What each tenant has, what it needs, and whether anything has drifted. */
  async status(): Promise<TenantMigrationStatus[]> {
    const pool = this.requirePool();
    const all = this.migrations();
    const tenants = await this.registry.list();

    const { rows } = await pool.query<{ tenant_id: string; version: string; checksum: string | null }>(
      `SELECT tenant_id, version, checksum FROM platform.tenant_migrations`,
    );

    const byTenant = new Map<string, Map<string, string | null>>();
    for (const row of rows) {
      if (!byTenant.has(row.tenant_id)) byTenant.set(row.tenant_id, new Map());
      byTenant.get(row.tenant_id)!.set(row.version, row.checksum);
    }

    return tenants.map((tenant) => {
      const recorded = byTenant.get(tenant.tenantId) ?? new Map();
      return {
        slug: tenant.slug,
        applied: all.filter((m) => recorded.has(m.version)).map((m) => m.version),
        pending: all.filter((m) => !recorded.has(m.version)).map((m) => m.version),
        // A recorded checksum that no longer matches the file means somebody
        // edited an applied migration. Surfaced rather than ignored, because
        // from here on the ledger is describing a schema that does not exist.
        drifted: all
          .filter((m) => recorded.has(m.version) && recorded.get(m.version) !== m.checksum)
          .map((m) => m.version),
      };
    });
  }

  /**
   * Applies everything outstanding to every active tenant.
   *
   * Continues past a tenant that fails rather than aborting the run: one
   * tenant with a wedged lock or an unexpected local change should not stop the
   * other 199 from being migrated. Failures come back in the result so the
   * caller can decide, and the run is safe to repeat.
   */
  async migrateAll(): Promise<FanOutResult[]> {
    const tenants = await this.registry.list();
    const results: FanOutResult[] = [];

    for (const tenant of tenants) {
      try {
        const applied = await this.migrateTenant(tenant);
        results.push({ slug: tenant.slug, applied });
        if (applied.length > 0) {
          this.logger.log(`Tenant ${tenant.slug}: applied ${applied.join(', ')}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Tenant ${tenant.slug}: ${message}`);
        results.push({ slug: tenant.slug, applied: [], error: message });
      }
    }

    return results;
  }

  /** Applies everything outstanding to one tenant. Returns the versions applied. */
  async migrateTenant(tenant: TenantDescriptor): Promise<string[]> {
    const pool = this.requirePool();
    assertValidTenantSchemaName(tenant.schemaName);
    assertValidTenantRoleName(tenant.roleName);

    const all = this.migrations();
    if (all.length === 0) return [];

    const client = await pool.connect();
    const applied: string[] = [];

    try {
      const recorded = await this.recordedFor(client, tenant.tenantId);

      for (const migration of all) {
        const existing = recorded.get(migration.version);

        if (existing !== undefined) {
          if (existing !== null && existing !== migration.checksum) {
            throw new MigrationChecksumMismatchError(tenant.slug, migration.version);
          }
          continue;
        }

        await this.applyOne(client, tenant, migration);
        applied.push(migration.version);
      }

      return applied;
    } finally {
      client.release();
    }
  }

  /**
   * Marks every current migration as applied without running it.
   *
   * For a freshly provisioned tenant, whose schema was built from the template
   * plus the full migration set in one go. Without this the runner would try to
   * apply them again on the next fan-out, and an additive migration would fail
   * on objects that already exist.
   */
  async recordBaseline(client: PoolClient, tenantId: string): Promise<void> {
    for (const migration of this.migrations()) {
      await client.query(
        `INSERT INTO platform.tenant_migrations (tenant_id, version, checksum)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, version) DO NOTHING`,
        [tenantId, migration.version, migration.checksum],
      );
    }
  }

  /** The SQL of every migration, concatenated — used to build a new tenant. */
  combinedSql(): string {
    return this.migrations()
      .map((m) => `-- ${m.filename}\n${m.sql}`)
      .join('\n;\n');
  }

  private async applyOne(
    client: PoolClient,
    tenant: TenantDescriptor,
    migration: TenantMigration,
  ): Promise<void> {
    const schemaIdent = escapeIdentifier(tenant.schemaName);
    const roleIdent = escapeIdentifier(tenant.roleName);

    try {
      await client.query('BEGIN');

      // Assumed so objects the migration creates are owned by the tenant role,
      // exactly as the ones provisioning created are. A table owned by the
      // admin role instead would be invisible to the tenant at runtime.
      await client.query(`SET LOCAL ROLE ${roleIdent}`);
      await client.query(`SET LOCAL search_path TO ${schemaIdent}`);
      await client.query(migration.sql);
      await client.query('RESET ROLE');

      // Recorded in the same transaction as the DDL. Postgres has
      // transactional DDL, so the schema change and the claim that it happened
      // commit together or not at all — the alternative is a ledger that can
      // disagree with the database after a crash between the two.
      await client.query(
        `INSERT INTO platform.tenant_migrations (tenant_id, version, checksum)
         VALUES ($1, $2, $3)`,
        [tenant.tenantId, migration.version, migration.checksum],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(
        `${migration.filename} failed for ${tenant.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async recordedFor(
    client: PoolClient,
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const { rows } = await client.query<{ version: string; checksum: string | null }>(
      `SELECT version, checksum FROM platform.tenant_migrations WHERE tenant_id = $1`,
      [tenantId],
    );
    return new Map(rows.map((r) => [r.version, r.checksum]));
  }

  private migrationsDir(): string {
    const packageRoot = dirname(require.resolve('@ovl/database/package.json'));
    return join(packageRoot, 'tenant-migrations');
  }

  private requirePool(): Pool {
    if (!this.adminPool) throw new ProvisioningDisabledError();
    return this.adminPool;
  }
}
