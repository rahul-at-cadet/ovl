import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Session from 'supertokens-node/recipe/session';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { TrpcRouter, createCallerFactory } from './trpc.router';
import { ADMIN_PG_POOL } from '../tenancy/tenancy.constants';
import { TenantRegistryService } from '../tenancy/tenant-registry.service';

/**
 * Tenant administration, exercised end to end against a live database.
 *
 * The procedures here create Postgres schemas and roles, so mocking the
 * services under them would prove nothing worth knowing — the whole risk is in
 * whether a real tenant comes out correctly provisioned and correctly
 * migrated. Everything below therefore runs against a real database through an
 * in-process tRPC caller: real procedure bodies, real provisioning, real
 * migration fan-out, no HTTP server.
 *
 * The one seam is SuperTokens session verification, which is stubbed to return
 * a chosen user id. That is authentication, not authorization: the super admin
 * check itself still reads `platform.super_admins` in the real database, which
 * is the part these tests are actually about.
 *
 * Skipped unless a database is configured; see test/integration-env.ts.
 */
const enabled = Boolean(
  process.env.TENANCY_TEST_DATABASE_URL && process.env.TENANCY_TEST_ADMIN_DATABASE_URL,
);
const describeTenants = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn(
    '[tenants-router] skipped: set TENANCY_TEST_DATABASE_URL and ' +
      'TENANCY_TEST_ADMIN_DATABASE_URL to run the live tenant administration tests.',
  );
}

jest.setTimeout(180_000);

const suffix = () => Math.random().toString(36).slice(2, 8);

const buildCaller = (router: TrpcRouter['appRouter']) =>
  createCallerFactory(router)({ req: { headers: {} }, res: {} } as never);

describeTenants('tenant administration (live database)', () => {
  let app: INestApplicationContext;
  let caller: ReturnType<typeof buildCaller>;
  let adminPool: Pool;

  const superAdminId = `st-super-${suffix()}`;
  const plainUserId = `st-plain-${suffix()}`;
  const provisioned: string[] = [];

  /** Which user the stubbed session claims to be, for the next call. */
  let actingAs = superAdminId;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    caller = buildCaller(app.get(TrpcRouter).appRouter);
    adminPool = app.get<Pool>(ADMIN_PG_POOL);

    // Authentication is stubbed; authorization is not. The procedures still
    // look this id up in platform.super_admins for real.
    jest
      .spyOn(Session, 'getSession')
      .mockImplementation(async () => ({ getUserId: () => actingAs }) as never);

    await adminPool.query(
      `INSERT INTO platform.super_admins (supertokens_user_id, email, created_by)
       VALUES ($1, $2, 'integration-test')
       ON CONFLICT (supertokens_user_id) DO NOTHING`,
      [superAdminId, `${superAdminId}@example.test`],
    );
    // The platform service caches super admin membership; without this the
    // row above is invisible for up to one TTL.
    app.get(TenantRegistryService).invalidate();
  });

  afterAll(async () => {
    // Provisioned tenants own a schema and a role, so leaving them behind
    // would leak database objects across runs.
    for (const slug of provisioned) {
      await adminPool
        .query(`DROP SCHEMA IF EXISTS ${`tenant_${slug}`} CASCADE`)
        .catch(() => undefined);
      await adminPool.query(`DROP ROLE IF EXISTS ${`tenant_${slug}_rw`}`).catch(() => undefined);
      await adminPool
        .query(`DELETE FROM platform.tenants WHERE slug = $1`, [slug])
        .catch(() => undefined);
    }
    await adminPool
      .query(`DELETE FROM platform.super_admins WHERE supertokens_user_id = $1`, [superAdminId])
      .catch(() => undefined);
    jest.restoreAllMocks();
    await app?.close();
  });

  beforeEach(() => {
    actingAs = superAdminId;
  });

  describe('access control', () => {
    it('reports super admin capability for a super admin', async () => {
      const caps = await caller.tenants.capabilities();
      expect(caps.tenancyEnabled).toBe(true);
      expect(caps.canProvision).toBe(true);
      expect(caps.isSuperAdmin).toBe(true);
    });

    it('reports no super admin capability for an ordinary office user', async () => {
      actingAs = plainUserId;
      const caps = await caller.tenants.capabilities();
      expect(caps.isSuperAdmin).toBe(false);
      // Still true — the deployment is multi-tenant regardless of who asks.
      expect(caps.tenancyEnabled).toBe(true);
    });

    it('refuses to list tenants for a non-super-admin', async () => {
      actingAs = plainUserId;
      await expect(caller.tenants.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses to provision a tenant for a non-super-admin', async () => {
      actingAs = plainUserId;
      await expect(
        caller.tenants.provision({ name: 'Should Not Exist' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses to destroy a tenant for a non-super-admin', async () => {
      actingAs = plainUserId;
      await expect(
        caller.tenants.destroy({ slug: 'anything', confirmation: 'drop tenant anything' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('provisioning', () => {
    it('creates a tenant that is active and fully migrated', async () => {
      const slug = `it_prov_${suffix()}`;
      provisioned.push(slug);

      const result = await caller.tenants.provision({ name: 'Northstar Shipping', slug });
      expect(result.slug).toBe(slug);
      expect(result.schemaName).toBe(`tenant_${slug}`);

      const listed = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(listed).toBeDefined();
      expect(listed!.name).toBe('Northstar Shipping');
      expect(listed!.status).toBe('active');
      // The point of surfacing migrations on the list at all: a brand new
      // tenant must be up to date, or its vessels fail on their first sync.
      expect(listed!.pendingMigrations).toEqual([]);
      expect(listed!.driftedMigrations).toEqual([]);
      expect(listed!.appliedMigrations.length).toBeGreaterThan(0);
    });

    it('gives the new schema the tables a vessel check-in writes to', async () => {
      const slug = `it_shape_${suffix()}`;
      provisioned.push(slug);
      await caller.tenants.provision({ name: 'Shape Check', slug });

      const { rows } = await adminPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'vessel_sync_status'`,
        [`tenant_${slug}`],
      );
      const columns = rows.map((r) => r.column_name);
      // These arrived with the vessel sync-diagnostics work, which was written
      // against the old shared schema. If they are missing here, tenant
      // provisioning has drifted from schema.ts again and pullConfig will fail
      // on its first insert.
      expect(columns).toEqual(expect.arrayContaining(['reported_name', 'reported_imo']));

      const { rows: tables } = await adminPool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'sync_runs'`,
        [`tenant_${slug}`],
      );
      expect(tables).toHaveLength(1);
    });

    it('derives a slug from the name when none is given', async () => {
      const name = `Derived ${suffix()}`;
      const result = await caller.tenants.provision({ name });
      provisioned.push(result.slug);
      expect(result.slug).toMatch(/^[a-z0-9_]+$/);
      expect(result.schemaName).toBe(`tenant_${result.slug}`);
    });
  });

  describe('lifecycle', () => {
    it('suspends and reactivates a tenant', async () => {
      const slug = `it_life_${suffix()}`;
      provisioned.push(slug);
      await caller.tenants.provision({ name: 'Lifecycle', slug });

      await caller.tenants.setStatus({ slug, status: 'suspended' });
      let listed = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(listed!.status).toBe('suspended');

      await caller.tenants.setStatus({ slug, status: 'active' });
      listed = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(listed!.status).toBe('active');
    });

    it('applies pending migrations to one tenant', async () => {
      const slug = `it_mig_${suffix()}`;
      provisioned.push(slug);
      await caller.tenants.provision({ name: 'Migration', slug });

      // Rewind this tenant to the shape it would have had before the
      // vessel-reported-identity migration existed, then prove the fan-out
      // repairs it — which is the upgrade path for every tenant that was
      // provisioned before that migration was written.
      const tenantId = (await caller.tenants.list()).find((t) => t.slug === slug)!.tenantId;
      await adminPool.query(`ALTER TABLE tenant_${slug}.vessel_sync_status
                               DROP COLUMN reported_name, DROP COLUMN reported_imo`);
      await adminPool.query(`DROP TABLE tenant_${slug}.sync_runs`);
      await adminPool.query(
        `DELETE FROM platform.tenant_migrations WHERE tenant_id = $1 AND version = '0002'`,
        [tenantId],
      );

      const before = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(before!.pendingMigrations).toContain('0002');

      const result = await caller.tenants.migrateTenant({ slug });
      expect(result.applied).toContain('0002');

      const after = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(after!.pendingMigrations).toEqual([]);

      const { rows } = await adminPool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'vessel_sync_status'
            AND column_name IN ('reported_name','reported_imo')`,
        [`tenant_${slug}`],
      );
      expect(rows).toHaveLength(2);
    });

    it('rejects a migration request for a tenant that does not exist', async () => {
      await expect(
        caller.tenants.migrateTenant({ slug: `it_missing_${suffix()}` }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('destruction', () => {
    it('refuses without the exact confirmation string', async () => {
      const slug = `it_keep_${suffix()}`;
      provisioned.push(slug);
      await caller.tenants.provision({ name: 'Keep Me', slug });

      await expect(
        caller.tenants.destroy({ slug, confirmation: 'drop tenant wrong' }),
      ).rejects.toThrow();

      // Still there. A confirmation guard that let the drop through on a near
      // miss would be worse than none, because it reads as protection.
      const stillListed = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(stillListed).toBeDefined();
    });

    it('drops the schema and the registry row on an exact confirmation', async () => {
      const slug = `it_drop_${suffix()}`;
      await caller.tenants.provision({ name: 'Drop Me', slug });

      await caller.tenants.destroy({ slug, confirmation: `drop tenant ${slug}` });

      const listed = (await caller.tenants.list()).find((t) => t.slug === slug);
      expect(listed).toBeUndefined();

      const { rows } = await adminPool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [`tenant_${slug}`],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
