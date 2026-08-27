import { randomUUID } from 'node:crypto';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TrpcRouter, createCallerFactory } from './trpc.router';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';
import { TenantRegistryService, type TenantDescriptor } from '../tenancy/tenant-registry.service';
import { runAsSystemForTenant } from '../tenancy/tenant-context';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import * as schema from '@ovl/database';
import { eq, sql } from 'drizzle-orm';
import * as crypto from 'node:crypto';

/**
 * The office↔vessel sync contract, exercised end to end against a live
 * database.
 *
 * This suite exists to be run BEFORE and AFTER the migration of the sync path
 * onto per-tenant schemas, unchanged. Its job is not to describe how sync ought
 * to work — it is to pin how it *does* work right now, so that moving the
 * tables underneath it cannot quietly change the answer a vessel gets.
 *
 * Several assertions below therefore record behaviour that is arguably wrong.
 * Where that is the case it is called out rather than corrected, because a
 * migration and a behaviour change must not travel in the same commit: if this
 * suite were written to describe the desired behaviour, it would fail before
 * the migration and there would be nothing left to tell a migration bug apart
 * from an intended fix.
 *
 * Driven through an in-process tRPC caller rather than HTTP — real procedure
 * bodies, real authentication, real database, no server. Skipped unless a
 * database is configured; see test/integration-env.ts.
 */
const enabled = Boolean(
  process.env.TENANCY_TEST_DATABASE_URL && process.env.TENANCY_TEST_ADMIN_DATABASE_URL,
);
const describeSync = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn(
    '[sync-contract] skipped: set TENANCY_TEST_DATABASE_URL and ' +
      'TENANCY_TEST_ADMIN_DATABASE_URL to run the live sync contract tests.',
  );
}

jest.setTimeout(180_000);

const suffix = () => Math.random().toString(36).slice(2, 8);

/**
 * A fully typed in-process caller for the office router.
 *
 * Built through a concrete function so TypeScript infers the router shape from
 * `TrpcRouter['appRouter']`. Passing the type argument to createCallerFactory
 * explicitly fights its own inference, which is what the router record
 * constraint complains about.
 */
const buildCaller = (router: TrpcRouter['appRouter'], token: string) =>
  createCallerFactory(router)({
    req: { headers: { authorization: `Bearer ${token}` } },
    res: {},
  } as never);

type SyncCaller = ReturnType<typeof buildCaller>;

describeSync('office↔vessel sync contract (live database)', () => {
  let app: INestApplicationContext;
  let caller: SyncCaller;
  let tenant: TenantDescriptor;
  let tenantSlug: string;
  let rawKey: string;
  let vesselId: string;

  const imo = String(9000000 + Math.floor(Math.random() * 999999));

  /** A caller carrying whatever bearer token the test wants to present. */
  const callerWith = (token: string): SyncCaller =>
    buildCaller(app.get(TrpcRouter).appRouter, token);

  const inTenant = <T>(fn: () => Promise<T>) =>
    runAsSystemForTenant({ ...tenant, requestId: 'sync-contract' }, fn);

  /**
   * Issues a vessel API key the same way apiKeys.create does.
   *
   * Done directly rather than through the procedure because that one is
   * session-authenticated, and these tests carry a bearer token rather than a
   * session. Key *minting* is not the subject here — the edge and sync
   * procedures are — so reproducing its two writes (the tenant's api_keys row
   * and the platform pointer) keeps the setup honest without dragging
   * SuperTokens into it.
   */
  const mintKey = async (label: string): Promise<{ raw: string; id: string }> => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const tokenLookupHash = crypto
      .createHash('sha256')
      .update(rawToken.substring(0, 8))
      .digest('hex');

    const [row] = await inTenant(() =>
      app.get(TenantDbService).withTenant((db) =>
        db
          .insert(schema.apiKeys)
          .values({
            label,
            tokenHash,
            tokenLookupHash,
            groupId: null,
            createdBy: 'contract-test',
            createdAt: new Date().toISOString(),
          })
          .returning(),
      ),
    );

    await app.get(EdgeTenantResolverService).register(tokenLookupHash, tenant.tenantId, label);
    return { raw: `ovl_prod_${rawToken}`, id: row.id };
  };

  /**
   * Where a row actually landed: the shared schema, this tenant's schema, or
   * neither.
   *
   * Deliberately migration-agnostic. Asserting "it is in public" would pass now
   * and fail the moment the sync path moves — by design, which is useless for
   * telling a migration bug from the migration itself. Asserting "it is in
   * exactly one of the two" holds before and after, and the reported location
   * documents the move as it happens.
   */
  const locate = async (
    table: 'vessels' | 'report_versions',
    column: string,
    value: string,
  ): Promise<'public' | 'tenant' | 'both' | 'neither'> => {
    const pool = (app.get(TenantDbService) as unknown as { pool: import('pg').Pool }).pool;
    const admin = await pool.connect();
    let inTenantSchema = false;
    try {
      await admin.query('BEGIN');
      await admin.query(`SET LOCAL ROLE "${tenant.roleName}"`);
      await admin.query(`SET LOCAL search_path TO "${tenant.schemaName}"`);
      const r = await admin.query(
        `SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`,
        [value],
      );
      inTenantSchema = (r.rowCount ?? 0) > 0;
      await admin.query('ROLLBACK');
    } finally {
      admin.release();
    }

    const legacy = app.get(TrpcRouter) as unknown as { db: { execute: Function } };
    let inPublic = false;
    try {
      const res: any = await legacy.db.execute(
        sql.raw(`SELECT 1 FROM public.${table} WHERE ${column} = '${value}' LIMIT 1`),
      );
      inPublic = (res.rowCount ?? res.rows?.length ?? 0) > 0;
    } catch {
      inPublic = false;
    }

    if (inPublic && inTenantSchema) return 'both';
    if (inPublic) return 'public';
    if (inTenantSchema) return 'tenant';
    return 'neither';
  };

  /** Revokes a key on both sides, as apiKeys.revoke does. */
  const revokeKey = async (id: string, rawToken: string) => {
    const lookup = crypto
      .createHash('sha256')
      .update(rawToken.replace(/^ovl_prod_/, '').substring(0, 8))
      .digest('hex');
    await inTenant(() =>
      app.get(TenantDbService).withTenant((db) =>
        db
          .update(schema.apiKeys)
          .set({ revokedAt: new Date().toISOString() })
          .where(eq(schema.apiKeys.id, id)),
      ),
    );
    await app.get(EdgeTenantResolverService).revoke(lookup);
  };

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

    tenantSlug = `it_sync_${suffix()}`;
    tenant = await app
      .get(TenantProvisioningService)
      .provision({ name: 'IT Sync', slug: tenantSlug });

    const issued = await mintKey(`it-sync-${suffix()}`);
    rawKey = issued.raw;
    caller = callerWith(rawKey);
  });

  afterAll(async () => {
    if (!app) return;
    await app
      .get(TenantProvisioningService)
      .destroy(tenantSlug, `drop tenant ${tenantSlug}` as `drop tenant ${string}`)
      .catch(() => undefined);
    await app.close();
  });

  describe('enrollment', () => {
    it('creates a vessel and returns its id', async () => {
      const result = await caller.edge.enroll({ vesselName: 'MV Contract', imoNumber: imo });
      expect(result.vesselId).toMatch(/^[0-9a-f-]{36}$/);
      vesselId = result.vesselId;
    });

    /**
     * A vessel that re-enrols — after a reinstall, or because its local store
     * was cleared — must come back with the same identity. A second vessel row
     * for one hull would split its report history in two.
     */
    it('is idempotent: re-enrolling the same IMO returns the same vessel', async () => {
      const again = await caller.edge.enroll({ vesselName: 'MV Contract', imoNumber: imo });
      expect(again.vesselId).toBe(vesselId);
    });

    it('refuses an unknown key', async () => {
      await expect(
        callerWith(`ovl_prod_${'0'.repeat(64)}`).edge.enroll({
          vesselName: 'MV Nobody',
          imoNumber: '1111111',
        }),
      ).rejects.toThrow();
    });

    it('refuses a malformed bearer token', async () => {
      await expect(
        callerWith('not-an-ovl-key').edge.enroll({ vesselName: 'MV Nobody', imoNumber: '2222222' }),
      ).rejects.toThrow();
    });
  });

  describe('pushEvents', () => {
    const reportId = randomUUID();

    const submitted = (versionNo: number, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      eventType: 'report_submitted',
      payload: JSON.stringify({
        reportId,
        versionNo,
        schemaName: 'bunker-report',
        eventType: 'ReportSubmitted',
        state: 'submitted',
        eventTime: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        submittedBy: 'contract-test',
        fields: { IMO: imo },
        ...extra,
      }),
      createdAt: new Date().toISOString(),
      processedAt: null,
    });

    it('lands a submitted report', async () => {
      await caller.sync.pushEvents({ vesselId, events: [submitted(1)] });

      // Landed in exactly one schema — which one is what the migration changes.
      await expect(locate('report_versions', 'report_id', reportId)).resolves.toMatch(
        /^(public|tenant)$/,
      );
    });

    it('records the vessel as seen', async () => {
      await caller.sync.pushEvents({ vesselId, events: [] });

      await expect(locate('vessels', 'id', vesselId)).resolves.toMatch(/^(public|tenant)$/);
    });

    it('accepts an empty batch', async () => {
      await expect(caller.sync.pushEvents({ vesselId, events: [] })).resolves.toBeDefined();
    });

    /**
     * PINNED, NOT ENDORSED. A malformed payload is caught inside the per-event
     * loop, logged, and the push still succeeds — so a vessel is told its
     * events landed when one of them did not. That is today's behaviour and the
     * migration must not change it; fixing it is a separate change with its own
     * test, because a vessel that believes a report was accepted will not
     * retry it.
     */
    it('silently drops an unparseable event and still reports success', async () => {
      const orphan = randomUUID();

      await expect(
        caller.sync.pushEvents({
          vesselId,
          events: [
            {
              id: orphan,
              eventType: 'report_submitted',
              payload: '{not json',
              createdAt: new Date().toISOString(),
              processedAt: null,
            },
          ],
        }),
      ).resolves.toBeDefined();

      await expect(locate('report_versions', 'report_id', orphan)).resolves.toBe('neither');
    });

    it('refuses a push with an unknown key', async () => {
      await expect(
        callerWith(`ovl_prod_${'1'.repeat(64)}`).sync.pushEvents({ vesselId, events: [] }),
      ).rejects.toThrow();
    });
  });

  describe('pullConfig', () => {
    it('answers with the shape the vessel expects', async () => {
      const response = await caller.sync.pullConfig({ vesselId });

      expect(response).toEqual(
        expect.objectContaining({
          syncedAt: expect.any(String),
          userCommands: expect.any(Array),
          chatMessages: expect.any(Array),
          remarks: expect.any(Array),
          invalidationNotices: expect.any(Array),
        }),
      );
    });

    /**
     * The cursor streams are the fragile half of sync — unlike the schema pull,
     * they carry resume state that a lost ack can strand. Pinning that a
     * high-water cursor returns nothing guards the migration against
     * re-delivering a vessel's entire chat history.
     */
    it('returns nothing above a high-water cursor', async () => {
      const response = await caller.sync.pullConfig({
        vesselId,
        lastChatSeq: '999999999',
        lastRemarkSeq: '999999999',
        lastInvalidationSeq: '999999999',
      });

      expect(response.chatMessages).toEqual([]);
      expect(response.remarks).toEqual([]);
      expect(response.invalidationNotices).toEqual([]);
    });

    it('refuses a pull with an unknown key', async () => {
      await expect(
        callerWith(`ovl_prod_${'2'.repeat(64)}`).sync.pullConfig({ vesselId }),
      ).rejects.toThrow();
    });

    it('tolerates being called repeatedly', async () => {
      const first = await caller.sync.pullConfig({ vesselId });
      const second = await caller.sync.pullConfig({ vesselId });
      expect(second.userCommands).toEqual(first.userCommands);
    });
  });

  describe('revocation', () => {
    it('stops a revoked key syncing', async () => {
      const issued = await mintKey(`it-revoke-${suffix()}`);

      await expect(
        callerWith(issued.raw).sync.pushEvents({ vesselId, events: [] }),
      ).resolves.toBeDefined();

      await revokeKey(issued.id, issued.raw);

      // Immediate, not eventual: a revoked vessel must stop syncing now, not
      // after a cache TTL.
      await expect(
        callerWith(issued.raw).sync.pushEvents({ vesselId, events: [] }),
      ).rejects.toThrow();
    });
  });
});
