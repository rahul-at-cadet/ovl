import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@ovl/vessel-database';
import { formSchemaChecksum } from '@ovl/vessel-database';
import { SchemaSyncService, type IncomingSchema } from './schema-sync.service';

/**
 * Failure behaviour of the office-to-vessel schema sync.
 *
 * Run against a real in-memory SQLite rather than a mock, because the property
 * under test is transactional atomicity — a fake would only prove that the fake
 * behaves as the test expects.
 *
 * The question every case here answers is the same: if this sync dies now, what
 * is the vessel left holding? The answer must always be "exactly the set it had
 * before, or exactly the new one" — never a mixture, and never something that
 * will render as a broken form.
 */
describe('SchemaSyncService failure scenarios', () => {
  let sqlite: Database.Database;
  let service: SchemaSyncService;

  const doc = (name: string, fields: string[]) => ({
    schemaName: name,
    version: '1.0',
    fields: fields.map((f) => ({ name: f, type: 'text' })),
  });

  const incoming = (name: string, fields: string[], overrides: Partial<IncomingSchema> = {}): IncomingSchema => {
    const document = doc(name, fields);
    return {
      schemaName: name,
      version: '1.0',
      checksum: formSchemaChecksum(document),
      content: JSON.stringify(document),
      ...overrides,
    };
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE form_schemas (
        schema_name text PRIMARY KEY NOT NULL,
        version text NOT NULL,
        checksum text NOT NULL,
        content text NOT NULL,
        synced_at text NOT NULL
      );
    `);
    service = new SchemaSyncService(drizzle(sqlite, { schema }));
  });

  afterEach(() => sqlite.close());

  const held = () =>
    sqlite.prepare('SELECT schema_name, version, checksum FROM form_schemas ORDER BY schema_name').all() as Array<{
      schema_name: string;
      version: string;
      checksum: string;
    }>;

  describe('the happy path it has to fail safely from', () => {
    it('applies a first sync', async () => {
      const result = await service.apply({
        changed: [incoming('bunker-report', ['IMO']), incoming('edn-report', ['A'])],
        removed: [],
      });

      expect(result.applied.sort()).toEqual(['bunker-report', 'edn-report']);
      expect(result.rejected).toEqual([]);
      expect(held().map((r) => r.schema_name)).toEqual(['bunker-report', 'edn-report']);
    });

    it('is idempotent — replaying the same payload changes nothing', async () => {
      const payload = { changed: [incoming('bunker-report', ['IMO'])], removed: [] };
      await service.apply(payload);
      const first = held();
      await service.apply(payload);
      expect(held()).toEqual(first);
    });
  });

  describe('a broken or hostile payload', () => {
    /**
     * The check that turns a bad link into a failed sync rather than a silently
     * wrong one. A truncated body still parses often enough to be dangerous.
     */
    it('rejects content whose checksum does not match what arrived', async () => {
      const item = incoming('bunker-report', ['IMO']);
      const truncated = { ...item, content: JSON.stringify(doc('bunker-report', ['IMO', 'EXTRA'])) };

      const result = await service.apply({ changed: [truncated], removed: [] });

      expect(result.applied).toEqual([]);
      expect(result.rejected[0].reason).toMatch(/checksum mismatch/);
      expect(held()).toEqual([]);
    });

    it('rejects malformed JSON without touching the store', async () => {
      const result = await service.apply({
        changed: [{ schemaName: 'x', version: '1.0', checksum: 'sha256:whatever', content: '{oops' }],
        removed: [],
      });

      expect(result.rejected[0].reason).toMatch(/invalid JSON/);
      expect(held()).toEqual([]);
    });

    it.each([
      ['no fields array', { schemaName: 'x', version: '1.0' }, /no fields array/],
      ['not an object', ['a', 'b'], /not an object/],
    ])('rejects a document that is %s', async (_label, document, expected) => {
      const content = JSON.stringify(document);
      const result = await service.apply({
        changed: [{ schemaName: 'x', version: '1.0', checksum: formSchemaChecksum(document), content }],
        removed: [],
      });

      expect(result.applied).toEqual([]);
      expect(result.rejected[0].reason).toMatch(expected);
      expect(held()).toEqual([]);
    });

    it.each([
      ['schemaName', { schemaName: '' }],
      ['version', { version: '' }],
      ['content', { content: '' }],
      ['checksum', { checksum: '' }],
    ])('rejects an item missing its %s', async (_field, override) => {
      const result = await service.apply({
        changed: [incoming('bunker-report', ['IMO'], override as Partial<IncomingSchema>)],
        removed: [],
      });
      expect(result.applied).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(held()).toEqual([]);
    });

    /**
     * Two entries for one schema have no single correct outcome, and
     * last-write-wins would silently pick one. Refusing the second is the only
     * answer that cannot be quietly wrong.
     */
    it('rejects a duplicate schemaName rather than guessing which one wins', async () => {
      const result = await service.apply({
        changed: [incoming('bunker-report', ['IMO']), incoming('bunker-report', ['OTHER'])],
        removed: [],
      });

      expect(result.applied).toEqual([]);
      expect(result.rejected[0].reason).toMatch(/duplicate/);
      expect(held()).toEqual([]);
    });
  });

  describe('partial failure inside one payload', () => {
    /**
     * The important one. A payload where one item is bad must not leave the
     * vessel holding the good half of a schema set — that is a fleet running
     * forms nobody chose.
     */
    it('applies nothing at all when any item is rejected mid-batch', async () => {
      await service.apply({ changed: [incoming('keeper', ['A'])], removed: [] });
      const before = held();

      const result = await service.apply({
        changed: [
          incoming('good-one', ['A']),
          { schemaName: 'bad-one', version: '1.0', checksum: 'sha256:nope', content: '{"fields":[]}' },
        ],
        removed: ['keeper'],
      });

      // Nothing applied, and — the point — the removal did not happen either.
      // Had it, this vessel would now hold neither 'keeper' nor its
      // replacement.
      expect(result.rejected).toHaveLength(1);
      expect(result.applied).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(held()).toEqual(before);
      expect(held().map((r) => r.schema_name)).toEqual(['keeper']);
    });

    /**
     * The case the all-or-nothing rule exists for: the office swaps one schema
     * for another in a single payload and the incoming one is corrupt. Applying
     * the removal alone would leave this vessel holding neither.
     */
    it('does not remove the old schema when its replacement is corrupt', async () => {
      await service.apply({ changed: [incoming('outgoing', ['A'])], removed: [] });

      const result = await service.apply({
        changed: [{ schemaName: 'incoming', version: '1.0', checksum: 'sha256:bad', content: '{"fields":[]}' }],
        removed: ['outgoing'],
      });

      expect(result.rejected).toHaveLength(1);
      expect(held().map((r) => r.schema_name)).toEqual(['outgoing']);
    });

    /**
     * Simulates the process dying between the delete and the insert — the
     * window that would otherwise leave a vessel with no form at all.
     */
    it('rolls back the removal if writing the replacement throws', async () => {
      await service.apply({ changed: [incoming('bunker-report', ['IMO'])], removed: [] });
      const before = held();

      const original = (service as unknown as { db: any }).db;
      const failing = {
        ...original,
        // Runs the real writes, then throws before the transaction commits —
        // standing in for the process dying between the delete and the insert.
        transaction: (fn: (tx: unknown) => void) =>
          original.transaction((tx: any) => {
            fn(tx);
            throw new Error('process died mid-apply');
          }),
      };
      (service as unknown as { db: any }).db = failing;

      await expect(
        service.apply({ changed: [incoming('replacement', ['B'])], removed: ['bunker-report'] }),
      ).rejects.toThrow('process died mid-apply');

      (service as unknown as { db: any }).db = original;

      // Nothing moved: the old schema is still there and the new one never
      // landed.
      expect(held()).toEqual(before);
    });
  });

  describe('recovery', () => {
    /**
     * The protocol carries no resume state — the vessel derives what it knows
     * from its own table each time — so a failed sync needs no repair. The next
     * check-in simply asks again.
     */
    it('reports what it holds so the next sync re-requests only what is missing', async () => {
      await service.apply({ changed: [incoming('bunker-report', ['IMO'])], removed: [] });

      const known = await service.known();
      expect(known).toEqual([
        { schemaName: 'bunker-report', checksum: formSchemaChecksum(doc('bunker-report', ['IMO'])) },
      ]);
    });

    it('reports nothing when the store is empty, so a fresh vessel gets everything', async () => {
      await expect(service.known()).resolves.toEqual([]);
    });

    it('leaves the store untouched when the office sends an empty payload', async () => {
      await service.apply({ changed: [incoming('bunker-report', ['IMO'])], removed: [] });
      const before = held();

      const result = await service.apply({ changed: [], removed: [] });

      expect(result).toEqual({ applied: [], removed: [], rejected: [] });
      expect(held()).toEqual(before);
    });

    it('survives a payload with missing arrays entirely', async () => {
      await expect(service.apply({} as never)).resolves.toEqual({
        applied: [],
        removed: [],
        rejected: [],
      });
    });
  });

  describe('un-adoption', () => {
    it('removes a schema the tenant stopped using', async () => {
      await service.apply({
        changed: [incoming('keeper', ['A']), incoming('goner', ['B'])],
        removed: [],
      });

      await service.apply({ changed: [], removed: ['goner'] });
      expect(held().map((r) => r.schema_name)).toEqual(['keeper']);
    });

    it('ignores a removal for something it never had', async () => {
      await service.apply({ changed: [incoming('keeper', ['A'])], removed: [] });
      await service.apply({ changed: [], removed: ['never-existed'] });
      expect(held().map((r) => r.schema_name)).toEqual(['keeper']);
    });
  });
});
