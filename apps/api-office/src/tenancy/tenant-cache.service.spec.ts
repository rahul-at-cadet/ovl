import { TenantCacheService } from './tenant-cache.service';
import { MissingTenantContextError, runWithTenant, type TenantContext } from './tenant-context';

const context = (slug: string): TenantContext => ({
  tenantId: `id-${slug}`,
  slug,
  schemaName: `tenant_${slug}`,
  roleName: `tenant_${slug}_rw`,
  requestId: `req-${slug}`,
});

describe('TenantCacheService', () => {
  let cache: TenantCacheService;

  beforeEach(() => {
    cache = new TenantCacheService();
  });

  it('caches within a tenant', async () => {
    const load = jest.fn(async () => 'value');

    await runWithTenant(context('acme'), async () => {
      expect(await cache.wrap('vessels', 'all', 1000, load)).toBe('value');
      expect(await cache.wrap('vessels', 'all', 1000, load)).toBe('value');
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  /**
   * The leak that survives every database-level defence.
   *
   * The connection binding guarantees a query cannot cross tenants. It says
   * nothing about a result cached under a bare key like `vessels:all` and then
   * served to the next caller — who may be someone else entirely. This test is
   * the reason the tenant id is prepended in one place instead of at each
   * call site.
   */
  it('never serves one tenant a value another tenant cached', async () => {
    const load = jest.fn(async () => 'acme-fleet');

    await runWithTenant(context('acme'), async () => {
      await cache.wrap('vessels', 'all', 1000, load);
    });

    const northstarLoad = jest.fn(async () => 'northstar-fleet');
    const seen = await runWithTenant(context('northstar'), () =>
      cache.wrap('vessels', 'all', 1000, northstarLoad),
    );

    expect(seen).toBe('northstar-fleet');
    expect(northstarLoad).toHaveBeenCalledTimes(1);
  });

  it('scopes get/set the same way as wrap', () => {
    runWithTenant(context('acme'), () => cache.set('config', 'bundle', 'acme-bundle', 1000));
    runWithTenant(context('northstar'), () => {
      expect(cache.get('config', 'bundle')).toBeUndefined();
    });
    runWithTenant(context('acme'), () => {
      expect(cache.get('config', 'bundle')).toBe('acme-bundle');
    });
  });

  it('expires entries', async () => {
    const load = jest.fn(async () => 'value');
    await runWithTenant(context('acme'), async () => {
      await cache.wrap('vessels', 'all', 1, load);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await cache.wrap('vessels', 'all', 1, load);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the current tenant', () => {
    runWithTenant(context('acme'), () => cache.set('config', 'bundle', 'a', 1000));
    runWithTenant(context('northstar'), () => cache.set('config', 'bundle', 'n', 1000));

    runWithTenant(context('acme'), () => cache.invalidateTenant());

    runWithTenant(context('acme'), () => expect(cache.get('config', 'bundle')).toBeUndefined());
    runWithTenant(context('northstar'), () => expect(cache.get('config', 'bundle')).toBe('n'));
  });

  it('refuses to cache outside a tenant context', async () => {
    await expect(cache.wrap('vessels', 'all', 1000, async () => 'x')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('prunes expired entries', async () => {
    runWithTenant(context('acme'), () => cache.set('a', 'b', 1, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.prune()).toBe(1);
  });
});
