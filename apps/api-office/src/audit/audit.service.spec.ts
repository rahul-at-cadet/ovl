import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import supertokens from 'supertokens-node';
import { AuditService } from './audit.service';
import { resolveTenancyOptions } from '../tenancy/tenancy.constants';

interface FakeClient {
  query: jest.Mock;
  release: jest.Mock;
}

/**
 * A pool whose clients record every statement, so the tests assert on the SQL
 * actually sent rather than on a mock of our own abstraction. The preamble is
 * the security boundary here, exactly as it is in TenantDbService.
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
            { rows: [{ bound_role: options.boundRole ?? 'audit_writer' }] },
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

const build = (pool: Pool) =>
  new AuditService(pool, resolveTenancyOptions({ connectionString: 'postgres://unused' }));

const statements = (client: FakeClient): string[] =>
  client.query.mock.calls.map((call) => String(call[0]));

describe('AuditService', () => {
  let errorSpy: jest.SpyInstance;
  let getUserSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    getUserSpy = jest
      .spyOn(supertokens, 'getUser')
      .mockResolvedValue({ emails: ['someone@example.test'] } as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    getUserSpy.mockRestore();
  });

  describe('record', () => {
    it('takes its own connection and assumes audit_writer inside a transaction', async () => {
      const { pool, clients, connect } = fakePool();

      await build(pool).record({
        event: 'impersonation.mode_changed',
        actorUserId: 'super-1',
        tenantSlug: 'acme',
      });

      // The whole reason this service exists rather than an inline INSERT: a
      // super admin in read mode is inside a `transaction_read_only` block,
      // and an INSERT on that connection would fail.
      expect(connect).toHaveBeenCalledTimes(1);

      const sql = statements(clients[0]).join('\n');
      expect(sql).toContain('BEGIN');
      expect(sql).toContain('SET LOCAL ROLE "audit_writer"');
      expect(sql).toContain('SET LOCAL search_path TO platform');
      expect(sql).toContain('INSERT INTO platform.audit_events');
      expect(statements(clients[0])).toContain('COMMIT');
      expect(clients[0].release).toHaveBeenCalledWith();
    });

    it('derives the retention class from the event name', async () => {
      const { pool, clients } = fakePool();

      await build(pool).record({ event: 'impersonation.started', actorUserId: 'super-1' });

      const insert = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO platform.audit_events'),
      );
      // Column order in the INSERT: tenant_id, tenant_slug, event, event_class.
      expect(insert?.[1][3]).toBe('impersonation');
    });

    it('fills in the actor email so the row survives the account being deleted', async () => {
      const { pool, clients } = fakePool();

      await build(pool).record({ event: 'user.deactivated', actorUserId: 'admin-1' });

      const insert = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO platform.audit_events'),
      );
      // Column order: ..., actor_user_id, actor_email, ...
      expect(insert?.[1][6]).toBe('someone@example.test');
    });

    it('keeps an email the caller supplied rather than looking one up', async () => {
      const { pool } = fakePool();

      await build(pool).record({
        event: 'user.deactivated',
        actorUserId: 'admin-1',
        actorEmail: 'known@example.test',
      });

      expect(getUserSpy).not.toHaveBeenCalled();
    });

    it('still records the event when the identity provider cannot be reached', async () => {
      getUserSpy.mockRejectedValue(new Error('supertokens down'));
      const { pool, clients } = fakePool();

      await build(pool).record({ event: 'user.deactivated', actorUserId: 'admin-1' });

      const insert = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('INSERT INTO platform.audit_events'),
      );
      expect(insert?.[1][6]).toBeNull();
    });

    it('drops an unclassified event rather than guessing its retention', async () => {
      const { pool, connect } = fakePool();

      await build(pool).record({ event: 'something.brand_new' });

      // Guessing wrong means an impersonation record deleted at twelve months,
      // so nothing is written at all and the loss is logged.
      expect(connect).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no retention class'));
    });

    it('never throws, so an audit failure cannot turn a sign-in into a 500', async () => {
      const { pool, clients } = fakePool({ failOn: /INSERT INTO platform\.audit_events/ });

      await expect(
        build(pool).record({ event: 'auth.login', actorUserId: 'user-1' }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to record audit event auth.login'),
        expect.anything(),
      );
      expect(statements(clients[0])).toContain('ROLLBACK');
    });

    it('refuses to write when the role did not actually bind', async () => {
      // SET LOCAL ROLE outside a transaction silently does nothing. A write
      // that landed as ovl_api would fail on grants; the check makes the
      // reason legible instead of leaving a bare permission error.
      const { pool, clients } = fakePool({ boundRole: 'ovl_api' });

      await build(pool).record({ event: 'auth.login', actorUserId: 'user-1' });

      expect(statements(clients[0]).join('\n')).not.toContain('INSERT INTO');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('expected role audit_writer'),
        expect.anything(),
      );
    });

    it('destroys a connection whose ROLLBACK failed instead of pooling it', async () => {
      const { pool, clients } = fakePool({
        failOn: /INSERT INTO platform\.audit_events/,
        failRollback: true,
      });

      await build(pool).record({ event: 'auth.login', actorUserId: 'user-1' });

      expect(clients[0].release).toHaveBeenCalledWith(true);
    });
  });

  describe('list', () => {
    it('assumes audit_reader, not audit_writer', async () => {
      const { pool, clients } = fakePool({ boundRole: 'audit_reader' });

      await build(pool).list({ tenantId: 'tenant-1' });

      expect(statements(clients[0]).join('\n')).toContain('SET LOCAL ROLE "audit_reader"');
    });

    it('confines the query to one tenant when a tenant is given', async () => {
      const { pool, clients } = fakePool({ boundRole: 'audit_reader' });

      await build(pool).list({ tenantId: 'tenant-1' });

      const select = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('FROM platform.audit_events'),
      );
      expect(String(select?.[0])).toContain('e.tenant_id = $1');
      expect(select?.[1][0]).toBe('tenant-1');
    });

    it('asks for platform-level events only when tenantId is explicitly null', async () => {
      const { pool, clients } = fakePool({ boundRole: 'audit_reader' });

      await build(pool).list({ tenantId: null });

      const select = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('FROM platform.audit_events'),
      );
      expect(String(select?.[0])).toContain('e.tenant_id IS NULL');
    });

    it('does throw, because an audit log that is empty from an error is worse than an error', async () => {
      const { pool } = fakePool({
        boundRole: 'audit_reader',
        failOn: /FROM platform\.audit_events/,
      });

      await expect(build(pool).list()).rejects.toThrow('statement failed');
    });

    it('caps the page size however large a limit is asked for', async () => {
      const { pool, clients } = fakePool({ boundRole: 'audit_reader' });

      await build(pool).list({ limit: 100_000 });

      const select = clients[0].query.mock.calls.find((call) =>
        String(call[0]).includes('FROM platform.audit_events'),
      );
      expect(select?.[1].at(-1)).toBe(500);
    });
  });
});
