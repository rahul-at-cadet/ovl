import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MasterCatalogService } from './master-catalog.service';
import { TenantCatalogService } from './tenant-catalog.service';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';
import { TenantRegistryService, type TenantDescriptor } from '../tenancy/tenant-registry.service';
import { SuperAdminService } from '../tenancy/super-admin.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { TenantMigrationRunnerService } from '../tenancy/tenant-migration-runner.service';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import { runAsSystemForTenant } from '../tenancy/tenant-context';
import { formSchemas } from '@ovl/database';
import { eq } from 'drizzle-orm';
import type { FormSchemaDocument } from './form-schema-document';

/**
 * The guarantees this subsystem exists to provide, exercised against a real
 * PostgreSQL.
 *
 * These cannot be unit tested and mean nothing if mocked: every property here
 * is enforced by Postgres roles and grants, so a fake pool would only assert
 * that the test's own fake behaves as the test expects. Every bug found while
 * building this — a GRANT that warned instead of failing, a psql variable that
 * was not interpolated, a role with no privilege on the catalogue — was
 * invisible to type checking and unit tests and obvious on a live database.
 *
 * Skipped unless a database is configured, so `npm test` stays fast and
 * dependency-free:
 *
 *   set -a && source .env.tenancy && set +a
 *   export TENANCY_TEST_DATABASE_URL="postgresql://ovl_api:$OVL_API_DB_PASSWORD@localhost:5432/ovl_tenancy_test"
 *   export TENANCY_TEST_ADMIN_DATABASE_URL="postgresql://ovl_admin:$OVL_ADMIN_DB_PASSWORD@localhost:5432/ovl_tenancy_test"
 *   npm run test:integration --workspace api-office
 *
 * The target database must already have had platform-bootstrap.sql applied.
 * Tenants are created with a random slug and destroyed afterwards, so the
 * suite is safe to run repeatedly against the same scratch database.
 */
const DATABASE_URL = process.env.TENANCY_TEST_DATABASE_URL;
const ADMIN_DATABASE_URL = process.env.TENANCY_TEST_ADMIN_DATABASE_URL;
const enabled = Boolean(DATABASE_URL && ADMIN_DATABASE_URL);

const describeIntegration = enabled ? describe : describe.skip;

if (!enabled) {
  // A skipped suite that says nothing looks like a passing suite. Say why.
  // eslint-disable-next-line no-console
  console.warn(
    '[catalogue-isolation] skipped: set TENANCY_TEST_DATABASE_URL and ' +
      'TENANCY_TEST_ADMIN_DATABASE_URL to run the live isolation checks.',
  );
}

jest.setTimeout(120_000);

const suffix = () => Math.random().toString(36).slice(2, 8);

describeIntegration('form catalogue isolation (live database)', () => {
  let app: INestApplicationContext;
  let master: MasterCatalogService;
  let catalogue: TenantCatalogService;
  let provisioning: TenantProvisioningService;
  let registry: TenantRegistryService;

  let alpha: TenantDescriptor;
  let beta: TenantDescriptor;
  let alphaSlug: string;
  let betaSlug: string;

  const superAdminId = `it_super_${suffix()}`;
  const schemaName = `it_schema_${suffix()}`;

  const inAlpha = <T>(fn: () => Promise<T>) =>
    runAsSystemForTenant({ ...alpha, requestId: 'integration' }, fn);
  const inBeta = <T>(fn: () => Promise<T>) =>
    runAsSystemForTenant({ ...beta, requestId: 'integration' }, fn);

  const document = (version: string, extraField?: string): FormSchemaDocument => ({
    schemaName,
    version,
    ovdVersion: '3.13',
    sections: ['header'],
    fields: [
      { name: 'IMO', label: 'IMO number', type: 'wholeNumber', section: 'header', schemaMandatory: true },
      ...(extraField ? [{ name: extraField, label: extraField, type: 'text', section: 'header' }] : []),
    ],
  });

  beforeAll(async () => {
    // The env is mapped in test/integration-env.ts, which must run before
    // app.module.ts is imported — it decides at module scope whether to
    // register TenancyModule, so setting it here would be too late.
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    master = app.get(MasterCatalogService);
    catalogue = app.get(TenantCatalogService);
    provisioning = app.get(TenantProvisioningService);
    registry = app.get(TenantRegistryService);

    alphaSlug = `it_alpha_${suffix()}`;
    betaSlug = `it_beta_${suffix()}`;
    alpha = await provisioning.provision({ name: 'IT Alpha', slug: alphaSlug });
    beta = await provisioning.provision({ name: 'IT Beta', slug: betaSlug });

    await app.get(SuperAdminService).grant(superAdminId, 'integration@ovl.test');
    await master.publish(superAdminId, { content: JSON.stringify(document('1.0')) });
  });

  afterAll(async () => {
    if (!app) return;
    // Best effort: a failed assertion must not leave tenants behind, but a
    // cleanup failure must not mask the real error either.
    for (const slug of [alphaSlug, betaSlug]) {
      if (!slug) continue;
      await provisioning
        .destroy(slug, `drop tenant ${slug}` as `drop tenant ${string}`)
        .catch(() => undefined);
    }
    await app.get(SuperAdminService).revoke(superAdminId).catch(() => undefined);

    // Destroying the tenants does not remove what this suite published into
    // the shared master catalogue — that lives in `platform` and outlives
    // them. Left behind, every run would add two more schemas to a catalogue
    // other people are looking at.
    await app
      .get(PlatformDbService)
      .runAsPublisher(async (db) =>
        db.delete(formSchemas).where(eq(formSchemas.schemaName, schemaName)),
      )
      .catch(() => undefined);

    await app.close();
  });

  describe('the opt-in', () => {
    it('does not serve a master schema a tenant has not adopted', async () => {
      // The absence of an implicit default is the whole model: a fallback would
      // let a super admin change what a tenant's crews see without the tenant
      // ever agreeing to it.
      await expect(inAlpha(() => catalogue.resolve(schemaName))).resolves.toBeNull();
      await expect(inBeta(() => catalogue.resolve(schemaName))).resolves.toBeNull();
    });

    it('adopts for one tenant without adopting for another', async () => {
      const version = (await master.getLatest(schemaName))!;
      await inAlpha(() => catalogue.adoptMaster(version.id, 'integration'));

      const resolvedAlpha = await inAlpha(() => catalogue.resolve(schemaName));
      expect(resolvedAlpha).toMatchObject({ source: 'master', origin: 'master', version: '1.0' });

      await expect(inBeta(() => catalogue.resolve(schemaName))).resolves.toBeNull();
    });
  });

  describe('fork on edit', () => {
    it('gives the forking tenant its own copy and leaves everyone else alone', async () => {
      const version = (await master.getLatest(schemaName))!;

      const fork = await inBeta(() => catalogue.fork(version.id, '1.0-beta', 'integration'));
      expect(fork).toMatchObject({ origin: 'fork', status: 'draft', forkedFromVersionId: version.id });

      const edited = { ...(fork.content as FormSchemaDocument) };
      edited.fields = [...edited.fields, { name: 'Beta_Only', label: 'Beta only', type: 'text', section: 'header' }];
      await inBeta(() => catalogue.updateDraft(fork.id, JSON.stringify(edited)));
      await inBeta(() => catalogue.publishOwn(fork.id, 'integration'));

      const resolvedBeta = await inBeta(() => catalogue.resolve(schemaName));
      expect(resolvedBeta).toMatchObject({ source: 'tenant', origin: 'fork', version: '1.0-beta' });
      expect(resolvedBeta!.content.fields.map((f) => f.name)).toContain('Beta_Only');

      // The property that matters: alpha is on master and must not have moved.
      const resolvedAlpha = await inAlpha(() => catalogue.resolve(schemaName));
      expect(resolvedAlpha!.version).toBe('1.0');
      expect(resolvedAlpha!.content.fields.map((f) => f.name)).not.toContain('Beta_Only');
    });

    it('leaves the master document byte-identical after a fork', async () => {
      const version = (await master.getLatest(schemaName))!;
      expect((version.content as FormSchemaDocument).fields).toHaveLength(1);
      expect(version.version).toBe('1.0');
    });

    it('records lineage precise enough to answer the upgrade question', async () => {
      const versions = await inBeta(() => catalogue.listOwnVersions(schemaName));
      const fork = versions.find((v) => v.version === '1.0-beta')!;

      const divergence = await inBeta(() => catalogue.forkDivergence(fork.id));
      expect(divergence.ourChanges.added).toEqual(['Beta_Only']);
      expect(divergence.ourChanges.removed).toEqual([]);
    });
  });

  describe('master is not writable by tenants', () => {
    it('refuses a publish from an identity that is not a super admin', async () => {
      await expect(
        master.publish(`it_nobody_${suffix()}`, { content: JSON.stringify(document('9.9')) }),
      ).rejects.toThrow(/super admin/i);
    });

    /**
     * The database-level guarantee, checked directly rather than through the
     * service — the service could be bypassed by a future code path, the grant
     * cannot.
     */
    it('denies a tenant role INSERT, UPDATE and DELETE on the catalogue at the database', async () => {
      const platform = app.get(PlatformDbService);
      const pool = (platform as unknown as { pool: import('pg').Pool }).pool;
      const client = await pool.connect();

      try {
        for (const statement of [
          `INSERT INTO platform.form_schemas (schema_name, title) VALUES ('evil', 'Evil')`,
          `UPDATE platform.form_schema_versions SET version = 'hacked'`,
          `DELETE FROM platform.form_schema_versions`,
        ]) {
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE "${alpha.roleName}"`);
          await expect(client.query(statement)).rejects.toThrow(/permission denied/i);
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    });

    it('allows a tenant role to READ the catalogue', async () => {
      const platform = app.get(PlatformDbService);
      const pool = (platform as unknown as { pool: import('pg').Pool }).pool;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE "${alpha.roleName}"`);
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM platform.form_schema_versions`,
        );
        expect(rows[0].n).toBeGreaterThan(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('a master upgrade notifies without moving anyone', () => {
    it('flags an upgrade but leaves both tenants on what they chose', async () => {
      await master.publish(superAdminId, {
        content: JSON.stringify(document('2.0', 'Platform_Added')),
      });

      const alphaEntry = (await inAlpha(() => catalogue.browse())).find(
        (e) => e.schemaName === schemaName,
      )!;
      const betaEntry = (await inBeta(() => catalogue.browse())).find(
        (e) => e.schemaName === schemaName,
      )!;

      expect(alphaEntry.masterVersion).toBe('2.0');
      expect(betaEntry.masterVersion).toBe('2.0');
      expect(alphaEntry.upgradeAvailable).toBe(true);
      expect(betaEntry.upgradeAvailable).toBe(true);

      // Notified, not moved. This is the requirement.
      expect((await inAlpha(() => catalogue.resolve(schemaName)))!.version).toBe('1.0');
      expect((await inBeta(() => catalogue.resolve(schemaName)))!.version).toBe('1.0-beta');
    });
  });

  describe('cross-tenant reads', () => {
    it('denies one tenant role access to another tenant schema', async () => {
      const platform = app.get(PlatformDbService);
      const pool = (platform as unknown as { pool: import('pg').Pool }).pool;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE "${alpha.roleName}"`);
        await expect(
          client.query(`SELECT count(*) FROM ${beta.schemaName}.form_schema_versions`),
        ).rejects.toThrow(/permission denied/i);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('leaves no tenant binding on a connection returned to the pool', async () => {
      // The pool-reuse case: the leak that only appears under concurrency.
      const platform = app.get(PlatformDbService);
      const pool = (platform as unknown as { pool: import('pg').Pool }).pool;

      await inAlpha(() => catalogue.resolve(schemaName));

      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          `SELECT current_user AS role, current_schema() AS schema`,
        );
        expect(rows[0].role).not.toBe(alpha.roleName);
        expect(rows[0].schema).not.toBe(alpha.schemaName);
      } finally {
        client.release();
      }
    });
  });

  describe('edge credential resolution', () => {
    /**
     * A vessel presents a bearer token and has no session, so its tenant is
     * resolved from the key. Getting this wrong in either direction is
     * serious: resolving to the wrong tenant serves another operator's fleet,
     * and treating the lookup hash as proof of identity would make a truncated
     * hash into a credential.
     */
    const alphaHash = `it_lookup_alpha_${suffix()}`;
    const betaHash = `it_lookup_beta_${suffix()}`;

    it('resolves each key to the tenant that issued it, and no other', async () => {
      const resolver = app.get(EdgeTenantResolverService);
      await resolver.register(alphaHash, alpha.tenantId, 'it-alpha-key');
      await resolver.register(betaHash, beta.tenantId, 'it-beta-key');

      await expect(resolver.resolve(alphaHash)).resolves.toMatchObject({ slug: alphaSlug });
      await expect(resolver.resolve(betaHash)).resolves.toMatchObject({ slug: betaSlug });
    });

    it('resolves an unknown key to null rather than to a default tenant', async () => {
      const resolver = app.get(EdgeTenantResolverService);
      await expect(resolver.resolve(`it_never_issued_${suffix()}`)).resolves.toBeNull();
    });

    it('stops resolving a revoked key', async () => {
      const resolver = app.get(EdgeTenantResolverService);
      const hash = `it_lookup_revoked_${suffix()}`;
      await resolver.register(hash, alpha.tenantId, 'it-revoked');
      await expect(resolver.resolve(hash)).resolves.not.toBeNull();

      await resolver.revoke(hash);
      // Revocation must be immediate, not eventual: the resolver invalidates
      // its own cache rather than leaving a revoked vessel working for a TTL.
      await expect(resolver.resolve(hash)).resolves.toBeNull();
    });

    it('refuses to resolve a key whose tenant has been suspended', async () => {
      const resolver = app.get(EdgeTenantResolverService);
      const hash = `it_lookup_suspended_${suffix()}`;
      await resolver.register(hash, beta.tenantId, 'it-suspended');

      await provisioning.setStatus(betaSlug, 'suspended');
      registry.invalidate();
      resolver.invalidate();
      await expect(resolver.resolve(hash)).resolves.toBeNull();

      await provisioning.setStatus(betaSlug, 'active');
      registry.invalidate();
      resolver.invalidate();
      await expect(resolver.resolve(hash)).resolves.not.toBeNull();
    });
  });

  describe('migration fan-out', () => {
    /**
     * A tenant built from the template plus the full migration set must land on
     * the same shape a migrated tenant reaches. If the baseline were not
     * recorded, the next fan-out would re-run every migration against objects
     * that already exist.
     */
    it('records a freshly provisioned tenant as fully migrated', async () => {
      const runner = app.get(TenantMigrationRunnerService);
      const status = await runner.status();

      for (const slug of [alphaSlug, betaSlug]) {
        const row = status.find((s) => s.slug === slug)!;
        expect(row.pending).toEqual([]);
        expect(row.drifted).toEqual([]);
        expect(row.applied).toEqual(runner.migrations().map((m) => m.version));
      }
    });

    it('is a no-op when everything is already applied', async () => {
      const runner = app.get(TenantMigrationRunnerService);
      const results = await runner.migrateAll();

      // Scoped to this suite's own tenants on purpose. migrateAll() is
      // fleet-wide, so asserting over every result would make this test depend
      // on whatever else happens to live in the target database — which is how
      // it failed the first time it ran, against leftover tenants that
      // predated the migration ledger.
      for (const slug of [alphaSlug, betaSlug]) {
        const result = results.find((r) => r.slug === slug)!;
        expect(result.error).toBeUndefined();
        expect(result.applied).toEqual([]);
      }
    });

    /**
     * Editing a migration that tenants have already applied means the ledger
     * stops describing the schema. Simulated here by tampering with the
     * recorded checksum, which is indistinguishable from the file having
     * changed underneath it.
     */
    it('refuses to run when an applied migration no longer matches what was recorded', async () => {
      const runner = app.get(TenantMigrationRunnerService);
      const migrations = runner.migrations();
      if (migrations.length === 0) return;

      const version = migrations[0].version;
      const pool = (runner as unknown as { adminPool: import('pg').Pool }).adminPool;

      await pool.query(
        `UPDATE platform.tenant_migrations SET checksum = 'sha256:tampered'
          WHERE tenant_id = $1 AND version = $2`,
        [alpha.tenantId, version],
      );

      try {
        const status = await runner.status();
        expect(status.find((s) => s.slug === alphaSlug)!.drifted).toContain(version);

        const results = await runner.migrateAll();
        expect(results.find((r) => r.slug === alphaSlug)!.error).toMatch(/has changed since/);

        // The other tenant is untouched: one tenant's drift does not stop the
        // rest of the fleet being migrated.
        expect(results.find((r) => r.slug === betaSlug)!.error).toBeUndefined();
      } finally {
        await pool.query(
          `UPDATE platform.tenant_migrations SET checksum = $3
            WHERE tenant_id = $1 AND version = $2`,
          [alpha.tenantId, version, migrations[0].checksum],
        );
      }
    });
  });

  it('registry lookups never resolve a tenant that is not active', async () => {
    await provisioning.setStatus(alphaSlug, 'suspended');
    registry.invalidate();
    await expect(registry.forSlug(alphaSlug)).resolves.toBeNull();

    await provisioning.setStatus(alphaSlug, 'active');
    registry.invalidate();
    await expect(registry.forSlug(alphaSlug)).resolves.not.toBeNull();
  });
});
