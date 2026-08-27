import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MasterCatalogService } from './master-catalog.service';
import { TenantCatalogService } from './tenant-catalog.service';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';
import { TenantRegistryService, type TenantDescriptor } from '../tenancy/tenant-registry.service';
import { SuperAdminService } from '../tenancy/super-admin.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { runAsSystemForTenant } from '../tenancy/tenant-context';
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

  it('registry lookups never resolve a tenant that is not active', async () => {
    await provisioning.setStatus(alphaSlug, 'suspended');
    registry.invalidate();
    await expect(registry.forSlug(alphaSlug)).resolves.toBeNull();

    await provisioning.setStatus(alphaSlug, 'active');
    registry.invalidate();
    await expect(registry.forSlug(alphaSlug)).resolves.not.toBeNull();
  });
});
