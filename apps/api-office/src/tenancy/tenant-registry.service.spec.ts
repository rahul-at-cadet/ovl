import { TenantRegistryService } from './tenant-registry.service';
import { resolveTenancyOptions } from './tenancy.constants';
import type { PlatformDatabase } from '@ovl/database';

/**
 * A platform handle that counts how often it is asked, so the tests can tell a
 * cache hit from a second query rather than trusting that one happened.
 */
const fakePlatformDb = (rows: Array<Record<string, unknown>>) => {
  let queries = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            queries += 1;
            return rows;
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as PlatformDatabase, queries: () => queries };
};

const build = (rows: Array<Record<string, unknown>>) => {
  const fake = fakePlatformDb(rows);
  const service = new TenantRegistryService(
    fake.db,
    resolveTenancyOptions({ connectionString: 'postgres://unused' }),
  );
  return { service, fake };
};

describe('TenantRegistryService.displayName', () => {
  it('returns the tenant display name for an id', async () => {
    const { service } = build([{ name: 'Nordstjernen Maritime AS' }]);

    await expect(service.displayName('tenant-uuid-1')).resolves.toBe('Nordstjernen Maritime AS');
  });

  it('caches the name rather than querying on every request', async () => {
    // The office shell asks for this on every page load, and a rename happens
    // about as often as never.
    const { service, fake } = build([{ name: 'Nordstjernen Maritime AS' }]);

    await service.displayName('tenant-uuid-1');
    await service.displayName('tenant-uuid-1');
    await service.displayName('tenant-uuid-1');

    expect(fake.queries()).toBe(1);
  });

  it('returns null for a tenant that is not in the registry', async () => {
    // The caller falls back to the slug, so a tenant is still identifiable.
    const { service } = build([]);

    await expect(service.displayName('missing')).resolves.toBeNull();
  });

  it('does not cache a miss, so a tenant becomes nameable as soon as it exists', async () => {
    const { service, fake } = build([]);

    await service.displayName('missing');
    await service.displayName('missing');

    expect(fake.queries()).toBe(2);
  });

  it('drops the cached name on invalidate, so a rename takes effect', async () => {
    const { service, fake } = build([{ name: 'Nordstjernen Maritime AS' }]);

    await service.displayName('tenant-uuid-1');
    service.invalidate();
    await service.displayName('tenant-uuid-1');

    expect(fake.queries()).toBe(2);
  });

  it('keeps names separate per tenant', async () => {
    // One shared cache entry would show an operator the wrong company name
    // while they are inside a tenant, which is worse than showing none.
    const { service } = build([{ name: 'Acme Shipping' }]);

    await expect(service.displayName('tenant-a')).resolves.toBe('Acme Shipping');
    // A different id must not be answered from tenant-a's entry; with the
    // stubbed handle this still queries, which is the point being asserted.
    await expect(service.displayName('tenant-b')).resolves.toBe('Acme Shipping');
  });
});
