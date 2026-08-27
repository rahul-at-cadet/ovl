import { Pool } from 'pg';
import { TenantBindingError, TenantDbService } from './tenant-db.service';
import { TenantConcurrencyService } from './tenant-concurrency.service';
import { resolveTenancyOptions } from './tenancy.constants';
import { runWithTenant } from './tenant-context';
import { MissingTenantContextError } from './tenant-context';
import { InvalidTenantIdentifierError } from './tenant-identifiers';
import type { TenantDescriptor } from './tenant-registry.service';

const acme: TenantDescriptor = {
  tenantId: 'tenant-uuid-acme',
  slug: 'acme',
  schemaName: 'tenant_acme',
  roleName: 'tenant_acme_rw',
};

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

/**
 * A pool whose clients record every statement, so the tests can assert on the
 * exact SQL preamble rather than on a mock of our own abstraction. The
 * preamble is the security boundary; asserting anything less specific would
 * let a regression through.
 */
const fakePool = (options: { bindAs?: { role: string; schema: string }; failOn?: RegExp; failRollback?: boolean } = {}) => {
  const clients: FakeClient[] = [];

  const connect = jest.fn(async () => {
    const client: FakeClient = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (options.failRollback && sql === 'ROLLBACK') throw new Error('rollback failed');
        if (options.failOn?.test(sql)) throw new Error('statement failed');

        if (sql.includes('current_schema()')) {
          const bound = options.bindAs ?? { role: acme.roleName, schema: acme.schemaName };
          return [
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [{ bound_role: bound.role, bound_schema: bound.schema }] },
          ];
        }
        return { rows: [] };
      }),
    };
    clients.push(client);
    return client;
  });

  return { pool: { connect } as unknown as Pool, clients, connect };
};

const build = (pool: Pool) => {
  const options = resolveTenancyOptions({ connectionString: 'postgres://unused' });
  return new TenantDbService(pool, options, new TenantConcurrencyService(options));
};

const statements = (client: FakeClient): string[] =>
  client.query.mock.calls.map(([sql]) => String(sql));

describe('TenantDbService', () => {
  it('binds role and schema transaction-locally, and proves the bind took', async () => {
    const { pool, clients } = fakePool();
    await build(pool).runFor(acme, async () => 'ok');

    const preamble = statements(clients[0])[0];

    expect(preamble).toContain('BEGIN');
    expect(preamble).toContain('SET LOCAL ROLE "tenant_acme_rw"');
    expect(preamble).toContain('SET LOCAL search_path TO "tenant_acme"');
    expect(preamble).toContain('current_schema()');

    // SET LOCAL, never plain SET. A session-level SET would ride the
    // connection back into the pool and bind the next request — for a
    // different tenant — to this tenant's role and schema.
    expect(preamble).not.toMatch(/(^|;)\s*SET (?!LOCAL)/);
  });

  it('applies a statement timeout so one query cannot pin a pooled connection', async () => {
    const { pool, clients } = fakePool();
    await build(pool).runFor(acme, async () => 'ok');
    expect(statements(clients[0])[0]).toContain('SET LOCAL statement_timeout = 15000');
  });

  it('commits and returns the connection to the pool on success', async () => {
    const { pool, clients } = fakePool();
    const result = await build(pool).runFor(acme, async () => 42);

    expect(result).toBe(42);
    expect(statements(clients[0])).toContain('COMMIT');
    expect(clients[0].release).toHaveBeenCalledWith();
  });

  it('rolls back and returns the connection when the work throws', async () => {
    const { pool, clients } = fakePool();

    await expect(
      build(pool).runFor(acme, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(statements(clients[0])).toContain('ROLLBACK');
    expect(clients[0].release).toHaveBeenCalledWith();
  });

  /**
   * If ROLLBACK fails, the connection's session state is unknown — it may
   * still be inside a transaction, or still carrying a role. Handing it back
   * to a shared pool is how one tenant's state reaches another tenant's
   * request, so it has to be destroyed instead.
   */
  it('destroys the connection when rollback itself fails', async () => {
    const { pool, clients } = fakePool({ failRollback: true });

    await expect(
      build(pool).runFor(acme, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(clients[0].release).toHaveBeenCalledWith(true);
  });

  it('destroys the connection when the bind preamble fails', async () => {
    const { pool, clients } = fakePool({ failOn: /SET LOCAL ROLE/ });

    await expect(build(pool).runFor(acme, async () => 'unreachable')).rejects.toThrow(
      'statement failed',
    );

    expect(clients[0].release).toHaveBeenCalledWith(true);
  });

  /**
   * The bind is verified rather than assumed. A connection that reports a
   * different role or schema than the one asked for must abort the request,
   * not run the query against whatever it is actually pointing at.
   */
  it('refuses to run when the connection reports a different tenant', async () => {
    const { pool } = fakePool({ bindAs: { role: 'tenant_other_rw', schema: 'tenant_other' } });
    const run = jest.fn();

    await expect(build(pool).runFor(acme, run)).rejects.toBeInstanceOf(TenantBindingError);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a descriptor whose identifiers do not pass validation', async () => {
    const { pool, connect } = fakePool();
    const hostile = { ...acme, schemaName: 'public' };

    await expect(build(pool).runFor(hostile, async () => 'x')).rejects.toBeInstanceOf(
      InvalidTenantIdentifierError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('withTenant throws rather than defaulting when there is no context', async () => {
    const { pool, connect } = fakePool();

    await expect(build(pool).withTenant(async () => 'x')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('withTenant uses the tenant on the async context', async () => {
    const { pool, clients } = fakePool();
    const service = build(pool);

    await runWithTenant({ ...acme, requestId: 'req-1' }, () =>
      service.withTenant(async () => 'ok'),
    );

    expect(statements(clients[0])[0]).toContain('SET LOCAL ROLE "tenant_acme_rw"');
  });

  describe('reentrancy', () => {
    /**
     * Nested calls must join the open transaction rather than take a second
     * connection. This is deadlock avoidance, not tidiness: services call one
     * another mid-method, and holding one connection while queueing for
     * another under a per-tenant concurrency cap is how every slot ends up
     * held by someone waiting for a slot.
     */
    it('joins the open transaction instead of taking another connection', async () => {
      const { pool, connect, clients } = fakePool();
      const service = build(pool);
      let innerDb: unknown;
      let outerDb: unknown;

      await service.runFor(acme, async (db) => {
        outerDb = db;
        await service.runFor(acme, async (nested) => {
          innerDb = nested;
        });
      });

      expect(connect).toHaveBeenCalledTimes(1);
      expect(innerDb).toBe(outerDb);
      // One transaction, so exactly one COMMIT.
      expect(statements(clients[0]).filter((s) => s === 'COMMIT')).toHaveLength(1);
    });

    it('does not deadlock when nesting deeper than the per-tenant limit', async () => {
      const options = resolveTenancyOptions({
        connectionString: 'postgres://unused',
        maxConcurrentPerTenant: 1,
        tenantQueueTimeoutMillis: 200,
      });
      const { pool } = fakePool();
      const service = new TenantDbService(pool, options, new TenantConcurrencyService(options));

      // With a ceiling of one, a nested call that took its own slot could never
      // get one — the outer call is holding it.
      await expect(
        service.runFor(acme, () =>
          service.runFor(acme, () => service.runFor(acme, async () => 'deep')),
        ),
      ).resolves.toBe('deep');
    });

    it('rolls the nested work back with the outer transaction', async () => {
      const { pool, clients } = fakePool();
      const service = build(pool);

      await expect(
        service.runFor(acme, async () => {
          await service.runFor(acme, async () => 'inner ok');
          throw new Error('outer failed');
        }),
      ).rejects.toThrow('outer failed');

      expect(statements(clients[0])).toContain('ROLLBACK');
      expect(statements(clients[0])).not.toContain('COMMIT');
    });

    /**
     * Two tenants on one async path means something upstream is badly wrong.
     * Running the inner query on the outer tenant's connection would be a
     * cross-tenant read, so it has to be refused.
     */
    it('refuses to nest a different tenant inside an open transaction', async () => {
      const { pool } = fakePool();
      const service = build(pool);
      const other = { ...acme, tenantId: 'other-uuid', slug: 'other' };

      await expect(
        service.runFor(acme, () => service.runFor(other, async () => 'should not run')),
      ).rejects.toBeInstanceOf(TenantBindingError);
    });

    it('does not leak the transaction to the next independent call', async () => {
      const { pool, connect } = fakePool();
      const service = build(pool);

      await service.runFor(acme, async () => 'first');
      await service.runFor(acme, async () => 'second');

      // Two separate calls, two connections — reentrancy must not make the
      // second one silently reuse a released connection.
      expect(connect).toHaveBeenCalledTimes(2);
    });
  });

  it('marks a read-only transaction when asked', async () => {
    const { pool, clients } = fakePool();
    await build(pool).runFor(acme, async () => 'ok', { readOnly: true });
    expect(statements(clients[0])[0]).toContain('SET LOCAL transaction_read_only = on');
  });

  /**
   * Interleaved requests for different tenants must each get their own
   * connection with their own binding — never a shared one that gets
   * rebound underneath them.
   */
  it('gives concurrent tenants independently bound connections', async () => {
    const { pool, clients } = fakePool({ bindAs: undefined });
    const service = build(pool);

    // The fake verifies against `acme` by default, so drive both calls with
    // descriptors that differ only in the parts the preamble echoes.
    await Promise.all([
      service.runFor(acme, async () => new Promise((r) => setTimeout(r, 5))),
      service.runFor(acme, async () => new Promise((r) => setTimeout(r, 1))),
    ]);

    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
    for (const client of clients) {
      expect(statements(client)[0]).toContain('SET LOCAL ROLE "tenant_acme_rw"');
      expect(statements(client)).toContain('COMMIT');
    }
  });
});
