import { ServiceUnavailableException } from '@nestjs/common';
import { TenantConcurrencyService } from './tenant-concurrency.service';
import { resolveTenancyOptions } from './tenancy.constants';

const build = (overrides: { maxConcurrentPerTenant?: number; tenantQueueTimeoutMillis?: number } = {}) =>
  new TenantConcurrencyService(
    resolveTenancyOptions({
      connectionString: 'postgres://unused',
      maxConcurrentPerTenant: 2,
      tenantQueueTimeoutMillis: 50,
      ...overrides,
    }),
  );

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('TenantConcurrencyService', () => {
  it('runs work up to the ceiling without queueing', async () => {
    const service = build();
    const gate = deferred();

    const running = [
      service.run('t1', () => gate.promise),
      service.run('t1', () => gate.promise),
    ];

    await Promise.resolve();
    expect(service.stats('t1')).toEqual({ active: 2, queued: 0 });

    gate.resolve();
    await Promise.all(running);
    expect(service.stats('t1')).toEqual({ active: 0, queued: 0 });
  });

  it('queues past the ceiling and admits on release', async () => {
    const service = build();
    const gate = deferred();
    const order: string[] = [];

    const first = service.run('t1', async () => {
      await gate.promise;
      order.push('first');
    });
    const second = service.run('t1', async () => {
      await gate.promise;
      order.push('second');
    });
    const third = service.run('t1', async () => {
      order.push('third');
    });

    await Promise.resolve();
    expect(service.stats('t1').queued).toBe(1);

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  /**
   * The property that keeps a busy tenant from becoming everyone's problem.
   * Schema-per-tenant isolates data, not the connection pool, so without this
   * one operator's heavy hour queues the pool for the whole fleet.
   */
  it('does not let one tenant block another', async () => {
    const service = build();
    const gate = deferred();

    const saturate = [
      service.run('busy', () => gate.promise),
      service.run('busy', () => gate.promise),
      service.run('busy', () => gate.promise).catch(() => undefined),
    ];

    let quietRan = false;
    await service.run('quiet', async () => {
      quietRan = true;
    });

    expect(quietRan).toBe(true);
    expect(service.stats('quiet')).toEqual({ active: 0, queued: 0 });

    gate.resolve();
    await Promise.all(saturate);
  });

  /**
   * Overload has to shed, not queue without bound. A request that waits
   * forever has consumed a socket and a request slot and will return nothing
   * useful even if it eventually runs.
   */
  it('sheds a request that waits longer than the queue timeout', async () => {
    const service = build({ tenantQueueTimeoutMillis: 20 });
    const gate = deferred();

    const held = [service.run('t1', () => gate.promise), service.run('t1', () => gate.promise)];
    const shed = service.run('t1', async () => 'never runs');

    await expect(shed).rejects.toBeInstanceOf(ServiceUnavailableException);

    gate.resolve();
    await Promise.all(held);
  });

  it('releases the slot when the work throws', async () => {
    const service = build();

    await expect(service.run('t1', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(service.stats('t1')).toEqual({ active: 0, queued: 0 });
  });

  /**
   * A long-lived process serves many tenants over its life. Bookkeeping that
   * is only ever added is a slow leak that shows up in production and never
   * in a test run — unless the test asserts it, as here.
   */
  it('forgets a tenant once it goes idle', async () => {
    const service = build();
    await service.run('transient', async () => undefined);
    expect(service.stats('transient')).toEqual({ active: 0, queued: 0 });
    expect((service as unknown as { slots: Map<string, unknown> }).slots.size).toBe(0);
  });
});
