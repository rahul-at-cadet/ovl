import { Pool } from 'pg';
import { TenantMembershipService } from './tenant-membership.service';
import { TenantRegistryService } from './tenant-registry.service';
import { resolveTenancyOptions } from './tenancy.constants';

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

/**
 * A pool whose clients record every statement, so these tests assert on the SQL
 * actually sent rather than on a mock of our own abstraction.
 *
 * The preamble is the security boundary here, exactly as it is in
 * TenantDbService and AuditService: the INSERT is only permitted because the
 * connection has assumed `tenant_membership_writer`, and a preamble that
 * quietly did not apply must fail loudly rather than fall through to whatever
 * `ovl_api` happens to hold.
 */
const fakePool = (options: { boundRole?: string; failOn?: RegExp; failRollback?: boolean } = {}) => {
  const clients: FakeClient[] = [];

  const connect = jest.fn(async () => {
    const client: FakeClient = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (options.failRollback && sql === 'ROLLBACK') throw new Error('rollback failed');
        if (options.failOn?.test(sql)) throw new Error('statement failed');

        if (sql.includes('current_user AS bound_role')) {
          return [
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [] },
            { rows: [{ bound_role: options.boundRole ?? 'tenant_membership_writer' }] },
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
  const registry = { invalidate: jest.fn() } as unknown as TenantRegistryService;
  const service = new TenantMembershipService(
    pool,
    resolveTenancyOptions({ connectionString: 'postgres://unused' }),
    registry,
  );
  return { service, registry };
};

const statements = (client: FakeClient): string[] =>
  client.query.mock.calls.map((call) => String(call[0]));

describe('TenantMembershipService', () => {
  describe('register', () => {
    it('assumes tenant_membership_writer inside a transaction before writing', async () => {
      const { pool, clients } = fakePool();
      const { service } = build(pool);

      await service.register('st-user-1', 'tenant-uuid-1');

      const sql = statements(clients[0]).join('\n');
      expect(sql).toContain('BEGIN');
      expect(sql).toContain('SET LOCAL ROLE "tenant_membership_writer"');
      expect(sql).toContain('SET LOCAL search_path TO platform');
      // The proof step. `SET LOCAL ROLE` outside a transaction silently does
      // nothing, so the role is verified rather than assumed.
      expect(sql).toContain('current_user AS bound_role');
      expect(sql).toContain('COMMIT');
    });

    it('writes the mapping with bound parameters, upserting on the identity', async () => {
      const { pool, clients } = fakePool();
      const { service } = build(pool);

      await service.register('st-user-1', 'tenant-uuid-1');

      const insert = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO platform.tenant_users'),
      );
      expect(insert).toBeDefined();
      // Re-running must repair an existing mapping rather than fail, so an
      // account created before this existed can be fixed by recreating it.
      expect(String(insert![0])).toContain('ON CONFLICT (supertokens_user_id) DO UPDATE');
      expect(insert![1]).toEqual(['st-user-1', 'tenant-uuid-1']);
    });

    it('refuses to write when the connection did not actually assume the role', async () => {
      // ovl_api holds SELECT on this table, so an unbound connection does not
      // necessarily fail on grants alone. Proving the role is what makes the
      // guarantee, rather than relying on which privilege happens to be absent.
      const { pool, clients } = fakePool({ boundRole: 'ovl_api' });
      const { service, registry } = build(pool);

      await expect(service.register('st-user-1', 'tenant-uuid-1')).rejects.toThrow(
        /expected role tenant_membership_writer.*connection reports ovl_api/s,
      );

      expect(statements(clients[0])).not.toContain(
        expect.stringContaining('INSERT INTO platform.tenant_users'),
      );
      expect(registry.invalidate).not.toHaveBeenCalled();
    });

    it('points at the bootstrap script when the role is missing', async () => {
      const { pool } = fakePool({ boundRole: 'ovl_api' });
      const { service } = build(pool);

      // A database that has not had section 10 applied is the likeliest cause,
      // and the error is the only place anyone will look for the fix.
      await expect(service.register('st-user-1', 'tenant-uuid-1')).rejects.toThrow(
        /platform-bootstrap\.sql/,
      );
    });

    it('invalidates the registry so the next request resolves the new tenant', async () => {
      const { pool } = fakePool();
      const { service, registry } = build(pool);

      await service.register('st-user-1', 'tenant-uuid-1');

      // forUser caches negative lookups too, so without this an account probed
      // before it was enrolled stays tenantless for a full TTL after creation.
      expect(registry.invalidate).toHaveBeenCalledTimes(1);
    });

    it('throws rather than swallowing a failed write, and rolls back', async () => {
      const { pool, clients } = fakePool({ failOn: /INSERT INTO platform\.tenant_users/ });
      const { service, registry } = build(pool);

      // Unlike an audit event, a lost membership row is not a gap in a log —
      // it is an account that cannot be used. Callers must hear about it.
      await expect(service.register('st-user-1', 'tenant-uuid-1')).rejects.toThrow(
        'statement failed',
      );

      expect(statements(clients[0])).toContain('ROLLBACK');
      expect(clients[0].release).toHaveBeenCalledWith();
      expect(registry.invalidate).not.toHaveBeenCalled();
    });

    it('destroys the connection when ROLLBACK itself fails', async () => {
      const { pool, clients } = fakePool({
        failOn: /INSERT INTO platform\.tenant_users/,
        failRollback: true,
      });
      const { service } = build(pool);

      await expect(service.register('st-user-1', 'tenant-uuid-1')).rejects.toThrow();

      // A connection whose ROLLBACK failed has unknown session state; returning
      // it to a shared pool is how one tenant's settings reach another's request.
      expect(clients[0].release).toHaveBeenCalledWith(true);
    });

    it('destroys the connection when the preamble itself fails', async () => {
      const { pool, clients } = fakePool({ failOn: /BEGIN/ });
      const { service } = build(pool);

      await expect(service.register('st-user-1', 'tenant-uuid-1')).rejects.toThrow();

      // No transaction is reliably open, so the connection cannot be reasoned
      // about and must not be reused.
      expect(clients[0].release).toHaveBeenCalledWith(true);
    });
  });
});
