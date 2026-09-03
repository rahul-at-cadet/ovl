import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as path from 'path';
import { Encrypter } from 'age-encryption';
import * as schema from '@ovl/vessel-database';
import { RestoreBundleService } from './restore-bundle.service';

jest.setTimeout(30_000);

/**
 * Runs against a real in-memory SQLite with the package's own
 * migrations, like the sync tests: this service exists to write rows, so
 * a mocked query builder would only prove the mock was called.
 *
 * The bundle is encrypted here with the age library directly rather than
 * by importing office's encrypt() — the two apps share no code, and
 * standing in for office at the wire boundary is exactly what a vessel
 * receiving a bundle does. Office's own suite carries the golden vector
 * proving that boundary matches the Go implementation.
 */
function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: path.join(path.dirname(require.resolve('@ovl/vessel-database/package.json')), 'drizzle'),
  });
  return db;
}

async function sealFor(recipient: string, bundle: unknown): Promise<string> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  const ciphertext = await e.encrypt(new TextEncoder().encode(JSON.stringify(bundle)));
  return Buffer.from(ciphertext).toString('base64');
}

function makeBundle(overrides: Record<string, unknown> = {}) {
  return {
    wireVersion: 1,
    vesselId: '11111111-1111-4111-8111-111111111111',
    vesselName: 'MV Test',
    vesselImo: '1234567',
    generatedAt: '2026-01-02T03:04:05.000Z',
    reports: [
      {
        reportId: 'r-1',
        versions: [
          {
            reportId: 'r-1',
            versionNo: 1,
            schemaKind: 'log-abstract.json',
            schemaVersion: '1.0',
            eventType: 'ReportSubmitted',
            state: 'submitted',
            eventTime: '2026-01-01T00:00:00.000Z',
            fields: { Latitude_Degree: 12 },
            submittedAt: '2026-01-01T00:05:00.000Z',
            receivedAt: '2026-01-01T00:06:00.000Z',
          },
        ],
        events: [
          {
            reportId: 'r-1',
            versionNo: 1,
            type: 'submitted',
            actor: 'chief.officer',
            at: '2026-01-01T00:05:00.000Z',
            detail: {},
          },
        ],
        chat: [
          {
            id: 'c-1',
            reportId: 'r-1',
            sender: 'shore.reviewer',
            body: 'Please confirm the bunker figure.',
            sentAt: '2026-01-01T01:00:00.000Z',
            direction: 'shore_to_ship',
          },
        ],
      },
    ],
    configBundle: {
      bundleId: 'b-1',
      versionNo: 7,
      content: { wireVersion: 1, bundleId: 'b-1', versionNo: 7, schemas: [] },
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('RestoreBundleService', () => {
  describe('the DR keypair', () => {
    it('mints, stores and reads back an identity', async () => {
      const svc = new RestoreBundleService(makeDb());
      expect(await svc.identity()).toBeNull();

      const publicKey = await svc.rotateIdentity();
      expect(publicKey).toMatch(/^age1[0-9a-z]+$/);

      const stored = await svc.identity();
      expect(stored?.publicKey).toBe(publicKey);
      expect(stored?.privateKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    });

    it('replaces the pair on every rotation', async () => {
      // Re-enrolment means the node was rebuilt. Keeping the old key
      // while shore records a new one is what would make a later restore
      // bundle unopenable by the node it was meant to rescue.
      const svc = new RestoreBundleService(makeDb());
      const first = await svc.rotateIdentity();
      const second = await svc.rotateIdentity();
      expect(second).not.toBe(first);
      expect((await svc.identity())!.publicKey).toBe(second);
    });
  });

  describe('importing a bundle', () => {
    it('refuses before the node has enrolled', async () => {
      const svc = new RestoreBundleService(makeDb());
      await expect(svc.importCiphertext('')).rejects.toThrow(/must complete enrollment/);
    });

    it('applies reports, events, chat and config', async () => {
      const db = makeDb();
      const svc = new RestoreBundleService(db);
      const recipient = await svc.rotateIdentity();

      const result = await svc.importCiphertext(await sealFor(recipient, makeBundle()));
      expect(result).toMatchObject({
        vesselName: 'MV Test',
        reports: 1,
        versions: 1,
        events: 1,
        chatMessages: 1,
        configBundleApplied: true,
      });

      const reports = await db.select().from(schema.reports);
      expect(reports).toHaveLength(1);
      expect(reports[0].schemaName).toBe('log-abstract.json');
      expect(reports[0].state).toBe('submitted');
      expect(reports[0].fields).toEqual({ Latitude_Degree: 12 });
      // Office keeps no submittedBy on the version row — it lives on the
      // 'submitted' audit event, and is recovered from there so the
      // restored report is attributed rather than blank.
      expect(reports[0].submittedBy).toBe('chief.officer');

      expect(await db.select().from(schema.reportEvents)).toHaveLength(1);
      const chat = await db.select().from(schema.chatMessages);
      expect(chat[0].direction).toBe('shore_to_ship');

      const config = (
        await db.select().from(schema.configStore).where(eq(schema.configStore.key, 'config_bundle'))
      )[0];
      // Stored in the same shape an ordinary sync pull writes, so the
      // restored node reads config through the identical path.
      expect(JSON.parse(config.value)).toEqual({ wireVersion: 1, bundleId: 'b-1', versionNo: 7, schemas: [] });
    });

    it('can be re-run without duplicating the audit trail', async () => {
      // A sync that fetched successfully then died mid-apply retries on
      // the next cycle. The Go original documents that doing so doubles
      // the event trail; this port dedups on the event's natural key so
      // the retry is free.
      const db = makeDb();
      const svc = new RestoreBundleService(db);
      const recipient = await svc.rotateIdentity();
      const sealed = await sealFor(recipient, makeBundle());

      await svc.importCiphertext(sealed);
      const second = await svc.importCiphertext(sealed);

      expect(second.events).toBe(0);
      expect(await db.select().from(schema.reportEvents)).toHaveLength(1);
      expect(await db.select().from(schema.reports)).toHaveLength(1);
      expect(await db.select().from(schema.chatMessages)).toHaveLength(1);
    });

    it('rejects a bundle encrypted for a different vessel', async () => {
      const svc = new RestoreBundleService(makeDb());
      await svc.rotateIdentity();

      const otherVessel = new RestoreBundleService(makeDb());
      const theirKey = await otherVessel.rotateIdentity();

      await expect(svc.importCiphertext(await sealFor(theirKey, makeBundle()))).rejects.toThrow(
        /different vessel, or before this node was last re-enrolled/,
      );
    });

    it('rejects a bundle from a newer office rather than half-applying it', async () => {
      const db = makeDb();
      const svc = new RestoreBundleService(db);
      const recipient = await svc.rotateIdentity();

      await expect(
        svc.importCiphertext(await sealFor(recipient, makeBundle({ wireVersion: 2 }))),
      ).rejects.toThrow(/unsupported restore bundle wire version 2/);
      expect(await db.select().from(schema.reports)).toHaveLength(0);
    });

    it('rejects a malformed report list before writing anything', async () => {
      const db = makeDb();
      const svc = new RestoreBundleService(db);
      const recipient = await svc.rotateIdentity();

      await expect(
        svc.importCiphertext(await sealFor(recipient, makeBundle({ reports: [{ reportId: 'r-1' }] }))),
      ).rejects.toThrow(/malformed report entry/);
      expect(await db.select().from(schema.reports)).toHaveLength(0);
    });

    it('applies a bundle with no config assignment', async () => {
      // A vessel with no bundle assignment at any scope is a real state,
      // not an error — the reports must still restore.
      const db = makeDb();
      const svc = new RestoreBundleService(db);
      const recipient = await svc.rotateIdentity();

      const result = await svc.importCiphertext(await sealFor(recipient, makeBundle({ configBundle: null })));
      expect(result.configBundleApplied).toBe(false);
      expect(await db.select().from(schema.reports)).toHaveLength(1);
    });
  });
});
