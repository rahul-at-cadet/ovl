import {
  MissingTenantContextError,
  currentTenant,
  runWithTenant,
  tryCurrentTenant,
  type TenantContext,
} from './tenant-context';

const context = (slug: string): TenantContext => ({
  tenantId: `id-${slug}`,
  slug,
  schemaName: `tenant_${slug}`,
  roleName: `tenant_${slug}_rw`,
  requestId: `req-${slug}`,
});

describe('tenant context', () => {
  it('fails closed when there is no context', () => {
    expect(tryCurrentTenant()).toBeUndefined();
    expect(() => currentTenant()).toThrow(MissingTenantContextError);
  });

  it('exposes the context to synchronous callees', () => {
    runWithTenant(context('acme'), () => {
      expect(currentTenant().slug).toBe('acme');
    });
  });

  it('survives await points', async () => {
    await runWithTenant(context('acme'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentTenant().slug).toBe('acme');
      await Promise.resolve();
      expect(currentTenant().schemaName).toBe('tenant_acme');
    });
  });

  /**
   * The test this whole module exists for.
   *
   * Two requests interleave at every await point, which is precisely what
   * happens under load and never happens when you exercise an endpoint by
   * hand. If tenant state lived on a module-level variable — a perfectly
   * natural-looking `let currentTenantId` — request B's assignment would
   * overwrite A's while A was suspended, and A would resume reading B's
   * schema. Nothing about that failure is visible in a single-request test.
   */
  it('keeps concurrent, interleaved requests separate', async () => {
    const observed: Array<{ expected: string; actual: string }> = [];

    const request = async (slug: string, delays: number[]) =>
      runWithTenant(context(slug), async () => {
        for (const delay of delays) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          observed.push({ expected: slug, actual: currentTenant().slug });
        }
      });

    await Promise.all([
      request('acme', [0, 12, 4, 20]),
      request('northstar', [6, 2, 16, 1]),
      request('pacific', [3, 9, 7, 11]),
    ]);

    expect(observed).toHaveLength(12);
    for (const { expected, actual } of observed) {
      expect(actual).toBe(expected);
    }
  });

  it('nests without leaking the inner tenant outward', async () => {
    await runWithTenant(context('outer'), async () => {
      await runWithTenant(context('inner'), async () => {
        await Promise.resolve();
        expect(currentTenant().slug).toBe('inner');
      });
      expect(currentTenant().slug).toBe('outer');
    });
  });

  it('does not leak out of the callback', async () => {
    await runWithTenant(context('acme'), async () => {
      expect(currentTenant().slug).toBe('acme');
    });
    expect(tryCurrentTenant()).toBeUndefined();
  });

  it('freezes the context so no callee can repoint a live request', () => {
    runWithTenant(context('acme'), () => {
      const tenant = currentTenant() as { schemaName: string };
      expect(() => {
        tenant.schemaName = 'tenant_someone_else';
      }).toThrow();
      expect(currentTenant().schemaName).toBe('tenant_acme');
    });
  });

  /**
   * Propagation follows async resources, not closures — and the distinction
   * decides how background work has to be written.
   *
   * A timer *scheduled* inside the context carries it, because the timer is
   * created on the context. A function merely *defined* inside the context
   * and called later from elsewhere does not, because the call happens on
   * whatever context the caller is on.
   *
   * The second half is the one that matters, and it fails safe: a handler
   * parked in a queue at startup and drained later gets no tenant and throws,
   * rather than silently inheriting whichever request ran most recently. That
   * is why every queue consumer, cron job and event listener must enter a
   * context explicitly via runAsSystemForTenant.
   */
  it('follows async resources, not closures', async () => {
    const scheduledInside = new Promise<string>((resolve) => {
      runWithTenant(context('acme'), () => {
        setTimeout(() => resolve(currentTenant().slug), 1);
      });
    });
    await expect(scheduledInside).resolves.toBe('acme');

    let parked: (() => string) | undefined;
    runWithTenant(context('acme'), () => {
      parked = () => currentTenant().slug;
    });
    expect(() => parked!()).toThrow(MissingTenantContextError);
  });
});
