import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import supertokens from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import { AppModule } from '../app.module';
import { TrpcRouter, createCallerFactory } from '../rpc/trpc.router';
import { TENANT_CONFLICT } from './tenant.middleware';
import { ADMIN_PG_POOL } from './tenancy.constants';
import { ConflictingIdentityError, TenantRegistryService } from './tenant-registry.service';
import { AlreadyATenantMemberError, SuperAdminService } from './super-admin.service';
import {
  AlreadyASuperAdminError,
  TenantProvisioningService,
} from './tenant-provisioning.service';

/**
 * One identity is either a tenant user or a platform super admin, never both.
 *
 * Exercised against a real database because the rule lives in SQL on both
 * sides — a `platform.tenant_users` probe before a promotion, a
 * `platform.super_admins` probe before an assignment, and a join in the
 * resolver — and mocking either query would only prove that the mock was
 * written to match the code.
 *
 * No tenant is provisioned here. These paths read the registry and nothing
 * else, so a registry row with a well-formed (but unbuilt) schema name is a
 * faithful stand-in and saves a schema, a role and a migration fan-out per run.
 *
 * Skipped unless a database is configured; see test/integration-env.ts.
 */
const enabled = Boolean(
  process.env.TENANCY_TEST_DATABASE_URL && process.env.TENANCY_TEST_ADMIN_DATABASE_URL,
);
const describeExclusivity = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn(
    '[identity-exclusivity] skipped: set TENANCY_TEST_DATABASE_URL and ' +
      'TENANCY_TEST_ADMIN_DATABASE_URL to run the live identity exclusivity tests.',
  );
}

jest.setTimeout(60_000);

const suffix = Math.random().toString(36).slice(2, 8);

describeExclusivity('super admin and tenant membership are mutually exclusive', () => {
  let app: INestApplicationContext;
  let adminPool: Pool;
  let registry: TenantRegistryService;
  let superAdmins: SuperAdminService;
  let provisioning: TenantProvisioningService;

  const slug = `excl_${suffix}`;
  let tenantId: string;

  /** An ordinary member of the tenant above. */
  const memberId = `st-member-${suffix}`;
  /** A platform super admin with no membership — the supported shape. */
  const adminId = `st-super-${suffix}`;
  const adminEmail = `${adminId}@example.test`;
  /** Already in the contradictory state, as a row written before this rule. */
  const conflictedId = `st-both-${suffix}`;

  const memberships = async (userId: string): Promise<number> => {
    const { rows } = await adminPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.tenant_users WHERE supertokens_user_id = $1`,
      [userId],
    );
    return Number(rows[0].n);
  };

  const grants = async (userId: string): Promise<number> => {
    const { rows } = await adminPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.super_admins WHERE supertokens_user_id = $1`,
      [userId],
    );
    return Number(rows[0].n);
  };

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    adminPool = app.get<Pool>(ADMIN_PG_POOL);
    registry = app.get(TenantRegistryService);
    superAdmins = app.get(SuperAdminService);
    provisioning = app.get(TenantProvisioningService);

    const { rows } = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.tenants (slug, name, schema_name, role_name, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [slug, `Exclusivity ${suffix}`, `tenant_${slug}`, `tenant_${slug}_rw`],
    );
    tenantId = rows[0].id;

    await adminPool.query(
      `INSERT INTO platform.tenant_users (supertokens_user_id, tenant_id) VALUES ($1, $2)`,
      [memberId, tenantId],
    );
    await adminPool.query(
      `INSERT INTO platform.super_admins (supertokens_user_id, email, created_by)
       VALUES ($1, $2, 'integration-test')`,
      [adminId, adminEmail],
    );
    registry.invalidate();
  });

  afterAll(async () => {
    for (const id of [memberId, adminId, conflictedId]) {
      await adminPool
        .query(`DELETE FROM platform.tenant_users WHERE supertokens_user_id = $1`, [id])
        .catch(() => undefined);
      await adminPool
        .query(`DELETE FROM platform.super_admins WHERE supertokens_user_id = $1`, [id])
        .catch(() => undefined);
    }
    await adminPool
      .query(`DELETE FROM platform.tenants WHERE slug = $1`, [slug])
      .catch(() => undefined);
    jest.restoreAllMocks();
    await app?.close();
  });

  describe('promotion refuses an existing tenant member', () => {
    it('refuses to grant super admin to an identity with a membership', async () => {
      await expect(superAdmins.grant(memberId, `${memberId}@example.test`)).rejects.toBeInstanceOf(
        AlreadyATenantMemberError,
      );
    });

    it('names the tenant they belong to, so the operator knows what to revoke', async () => {
      await expect(superAdmins.grant(memberId, `${memberId}@example.test`)).rejects.toThrow(slug);
    });

    it('writes nothing when it refuses', async () => {
      await superAdmins.grant(memberId, `${memberId}@example.test`).catch(() => undefined);
      expect(await grants(memberId)).toBe(0);
    });

    it('still promotes an identity that belongs to no tenant', async () => {
      const unaffiliated = `st-clean-${suffix}`;
      try {
        await superAdmins.grant(unaffiliated, `${unaffiliated}@example.test`);
        expect(await grants(unaffiliated)).toBe(1);
      } finally {
        await adminPool.query(
          `DELETE FROM platform.super_admins WHERE supertokens_user_id = $1`,
          [unaffiliated],
        );
      }
    });
  });

  describe('assignment refuses an existing super admin', () => {
    it('refuses to add a super admin to a tenant', async () => {
      await expect(provisioning.assignUser(adminId, tenantId)).rejects.toBeInstanceOf(
        AlreadyASuperAdminError,
      );
    });

    it('writes nothing when it refuses', async () => {
      await provisioning.assignUser(adminId, tenantId).catch(() => undefined);
      expect(await memberships(adminId)).toBe(0);
    });

    it("refuses a first admin whose email is already a super admin's", async () => {
      // The SuperTokens lookup is the one external call on this path and is
      // not what is under test; the account deliberately does not exist yet,
      // which is the case the email match is there to catch.
      const lookup = jest
        .spyOn(supertokens, 'listUsersByAccountInfo')
        .mockResolvedValue([] as never);

      await expect(
        provisioning.createFirstAdmin(
          { tenantId, slug, schemaName: `tenant_${slug}`, roleName: `tenant_${slug}_rw` },
          adminEmail.toUpperCase(),
        ),
      ).rejects.toBeInstanceOf(AlreadyASuperAdminError);

      // Refused before anything was created: had it got as far as writing a
      // profile, the tenant would be left with an account nobody can sign in
      // as and nothing cleans up.
      expect(await memberships(adminId)).toBe(0);
      lookup.mockRestore();
    });
  });

  describe('resolution refuses an identity already holding both rows', () => {
    beforeAll(async () => {
      // Written straight to the registry, bypassing both services — this is
      // the state the enforcement above cannot undo, only refuse to serve.
      await adminPool.query(
        `INSERT INTO platform.tenant_users (supertokens_user_id, tenant_id) VALUES ($1, $2)`,
        [conflictedId, tenantId],
      );
      await adminPool.query(
        `INSERT INTO platform.super_admins (supertokens_user_id, email, created_by)
         VALUES ($1, $2, 'integration-test')`,
        [conflictedId, `${conflictedId}@example.test`],
      );
      registry.invalidate();
    });

    it('throws rather than silently serving one of the two tenants', async () => {
      await expect(registry.forUser(conflictedId)).rejects.toBeInstanceOf(ConflictingIdentityError);
    });

    it('names both the identity and the tenant in the message', async () => {
      await expect(registry.forUser(conflictedId)).rejects.toThrow(
        new RegExp(`${conflictedId}.*${slug}`),
      );
    });

    it('does not cache the conflict away — it fails on every request', async () => {
      await expect(registry.forUser(conflictedId)).rejects.toBeInstanceOf(ConflictingIdentityError);
      await expect(registry.forUser(conflictedId)).rejects.toBeInstanceOf(ConflictingIdentityError);
    });

    it('still resolves an ordinary member of the same tenant', async () => {
      await expect(registry.forUser(memberId)).resolves.toMatchObject({ slug, tenantId });
    });

    it('still resolves nothing for a super admin who has selected no tenant', async () => {
      await expect(registry.forUser(adminId)).resolves.toBeNull();
    });

    it('reaches a tRPC caller as FORBIDDEN, not as an unparseable 500', async () => {
      // `tenants.capabilities` is the call that decides what the shell renders
      // — the one that used to answer 200 with a tenant name the data layer
      // would not serve. Driven through the real router so the assertion is
      // about the `isAuthed` middleware, not about a stub of it.
      jest
        .spyOn(Session, 'getSession')
        .mockImplementation(async () => ({ getUserId: () => conflictedId }) as never);

      const caller = createCallerFactory(app.get(TrpcRouter).appRouter)({
        req: { headers: {}, [TENANT_CONFLICT]: 'both a member and a super admin' },
        res: {},
      } as never);

      await expect(caller.tenants.capabilities()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'both a member and a super admin',
      });
    });
  });
});
