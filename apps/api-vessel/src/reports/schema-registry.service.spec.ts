import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as path from 'path';
import * as schema from '@ovl/vessel-database';
import { SchemaRegistryService } from './schema-registry.service';

jest.setTimeout(30_000);

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: path.join(path.dirname(require.resolve('@ovl/vessel-database/package.json')), 'drizzle'),
  });
  return db;
}

/** An office-published document, in the exact shape office stores. */
function published(overrides: Partial<Record<string, unknown>> = {}) {
  const doc = {
    schemaName: 'bunker-report',
    version: '4.0',
    fields: [
      { name: 'Bunker_Port', type: 'text', schemaMandatory: true },
      { name: 'Office_Added_Field', type: 'text', schemaMandatory: false },
    ],
    ...(overrides.doc as object ?? {}),
  };
  return {
    // Office names schemas bare; the registry keys on the vessel's own
    // ".json" convention, and normalising between the two is the thing
    // most likely to be got wrong.
    schemaName: 'bunker-report',
    version: '4.0',
    source: 'office',
    content: JSON.stringify(doc),
    publishedAt: '2026-09-01T00:00:00.000Z',
    receivedAt: '2026-09-01T00:00:01.000Z',
    ...overrides,
  } as typeof schema.schemaVersions.$inferInsert;
}

describe('SchemaRegistryService', () => {
  it('falls back to the bundled schemas when nothing has been synced', async () => {
    const svc = new SchemaRegistryService(makeDb());
    await svc.onModuleInit();
    // The build ships these, so a vessel that has never reached shore can
    // still file reports.
    expect(svc.getSchema('bunker-report').schemaName).toBe('bunker-report');
    expect(svc.getSchema('log-abstract').schemaName).toBe('log-abstract');
  });

  it('lets an office-published schema override the bundled copy', async () => {
    const db = makeDb();
    await db.insert(schema.schemaVersions).values(published());
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();

    const loaded = svc.getSchema('bunker-report');
    expect(loaded.fields.map((f) => f.name)).toContain('Office_Added_Field');
    // Looked up by the bare name too — office stores it bare, the
    // registry keys on ".json", and both must resolve.
    expect(svc.getSchema('bunker-report.json').fields).toEqual(loaded.fields);
  });

  it('validates against the published schema, not the bundled one', async () => {
    const db = makeDb();
    await db.insert(schema.schemaVersions).values(published());
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();

    // Mandatory in the published document; absent here.
    expect(() => svc.validate('bunker-report.json', { Office_Added_Field: 'x' })).toThrow();
    expect(() => svc.validate('bunker-report.json', { Bunker_Port: 'Rotterdam' })).not.toThrow();
  });

  it('keeps a report that carries fields the new schema dropped', async () => {
    // Schemas are compiled with additionalProperties, so publishing a
    // narrower document must not retroactively invalidate saved work.
    const db = makeDb();
    await db.insert(schema.schemaVersions).values(published());
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();
    expect(() =>
      svc.validate('bunker-report.json', { Bunker_Port: 'Rotterdam', Retired_Field: 'still here' }),
    ).not.toThrow();
  });

  it('takes the newest published version when several are held', async () => {
    const db = makeDb();
    await db.insert(schema.schemaVersions).values([
      published({ version: '4.0', publishedAt: '2026-09-01T00:00:00.000Z' }),
      published({
        version: '5.0',
        publishedAt: '2026-09-02T00:00:00.000Z',
        content: JSON.stringify({
          schemaName: 'bunker-report',
          version: '5.0',
          fields: [{ name: 'Newest_Only', type: 'text', schemaMandatory: false }],
        }),
      }),
    ]);
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();
    expect(svc.getSchema('bunker-report').fields.map((f) => f.name)).toEqual(['Newest_Only']);
  });

  it('keeps the working schema when office publishes an unusable one', async () => {
    // A vessel at sea must not be left unable to validate anything
    // because shore published a broken document.
    const db = makeDb();
    await db.insert(schema.schemaVersions).values(published({ content: '{ not json' }));
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();
    expect(svc.getSchema('bunker-report').schemaName).toBe('bunker-report');
    expect(svc.getSchema('bunker-report').fields.length).toBeGreaterThan(1);
  });

  it('rejects a published document that declares no fields', async () => {
    const db = makeDb();
    await db.insert(schema.schemaVersions).values(
      published({ content: JSON.stringify({ schemaName: 'bunker-report', version: '4.0', fields: [] }) }),
    );
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();
    // Still the bundled copy, which has real fields.
    expect(svc.getSchema('bunker-report').fields.length).toBeGreaterThan(0);
  });

  it('picks up a schema published after boot, without a restart', async () => {
    // The whole reason schemas travel over sync: a ship at sea cannot be
    // asked to reboot to pick up a new report form.
    const db = makeDb();
    const svc = new SchemaRegistryService(db);
    await svc.onModuleInit();
    expect(svc.getSchema('bunker-report').fields.map((f) => f.name)).not.toContain('Office_Added_Field');

    await db.insert(schema.schemaVersions).values(published());
    const applied = await svc.loadSyncedSchemas();

    expect(applied).toBe(1);
    expect(svc.getSchema('bunker-report').fields.map((f) => f.name)).toContain('Office_Added_Field');
  });
});
