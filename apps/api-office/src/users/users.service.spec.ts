import { Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import EmailPassword from 'supertokens-node/recipe/emailpassword';

// Mocked at the module level rather than spied on: argon2's native binding
// exports non-configurable properties, so jest.spyOn cannot redefine them. The
// hash itself is not what these tests are about.
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(async () => 'argon2-hash'),
}));
import { UsersService } from './users.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { TenantDbService } from '../tenancy/tenant-db.service';
import type { TenantMembershipService } from '../tenancy/tenant-membership.service';
import { runWithTenant, type TenantContext } from '../tenancy/tenant-context';

const ACME: TenantContext = {
  tenantId: 'tenant-uuid-acme',
  slug: 'acme',
  schemaName: 'tenant_acme',
  roleName: 'tenant_acme_rw',
  requestId: 'test-request',
};

const CREATED_ROW = {
  id: 'profile-uuid-1',
  username: 'mate@acme.test',
  passwordHash: 'argon2-hash',
  roles: ['viewer'],
  mustChangePassword: true,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * A stand-in for the Drizzle handle, chainable in the shapes createUser uses.
 *
 * `deleted` is what the compensating rollback is asserted against: the point of
 * these tests is not that some query ran, but that a profile which could not be
 * mapped to a tenant does not survive.
 */
const fakeDb = (options: { existingUsernames?: string[] } = {}) => {
  const deleted: unknown[] = [];
  const inserted: unknown[] = [];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            (options.existingUsernames ?? []).length ? [{ id: 'existing-uuid' }] : [],
        }),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        inserted.push(values);
        return { returning: async () => [{ ...CREATED_ROW, ...(values as object) }] };
      },
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        deleted.push(condition);
        return [];
      },
    }),
  };

  return { db, deleted, inserted };
};

const build = (options: { db?: ReturnType<typeof fakeDb>; registerFails?: Error } = {}) => {
  const fake = options.db ?? fakeDb();

  const tenantDb = {
    withTenant: jest.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(fake.db)),
  } as unknown as TenantDbService;

  const membership = {
    register: jest.fn(async () => {
      if (options.registerFails) throw options.registerFails;
    }),
  } as unknown as TenantMembershipService;

  return { service: new UsersService(tenantDb, membership), tenantDb, membership, fake };
};

const dto = { username: 'mate@acme.test', roles: ['viewer'] } as unknown as CreateUserDto;

describe('UsersService.createUser', () => {
  let signUpSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const hashMock = argon2.hash as unknown as jest.Mock;

  beforeEach(() => {
    signUpSpy = jest
      .spyOn(EmailPassword, 'signUp')
      .mockResolvedValue({ status: 'OK', user: { id: 'st-user-1' } } as never);
    hashMock.mockClear();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The regression this file exists for.
   *
   * createUser wrote the SuperTokens identity and the tenant-schema profile and
   * stopped there. platform.tenant_users was written only by
   * TenantProvisioningService — once per tenant, and once for its first admin —
   * so every account an office admin created afterwards resolved to no tenant:
   * able to authenticate, rejected by AuthGuard, FORBIDDEN from every procedure
   * calling requireTenant().
   */
  it('registers the membership for the tenant the request resolved to', async () => {
    const { service, membership } = build();

    const result = await runWithTenant(ACME, () => service.createUser(dto));

    expect(membership.register).toHaveBeenCalledWith('st-user-1', ACME.tenantId);
    expect(result.supertokensUserId).toBe('st-user-1');
  });

  it('maps the primary SuperTokens id, which is what a session reports', async () => {
    // TenantRegistryService.forUser is keyed on session.getUserId(). A recipe
    // user id would insert a row that never matches and reintroduce the bug in
    // a form that looks correct in the database.
    signUpSpy.mockResolvedValue({
      status: 'OK',
      user: { id: 'primary-id' },
      recipeUserId: { getAsString: () => 'recipe-id' },
    } as never);
    const { service, membership } = build();

    await runWithTenant(ACME, () => service.createUser(dto));

    expect(membership.register).toHaveBeenCalledWith('primary-id', ACME.tenantId);
  });

  it('still creates the identity and the profile', async () => {
    const { service, fake } = build();

    const result = await runWithTenant(ACME, () => service.createUser(dto));

    expect(signUpSpy).toHaveBeenCalledWith('public', 'mate@acme.test', result.temporaryPassword);
    expect(hashMock).toHaveBeenCalled();
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0]).toMatchObject({
      username: 'mate@acme.test',
      mustChangePassword: true,
      active: true,
    });
    // The reveal-once contract is unchanged.
    expect(result.temporaryPassword).toHaveLength(12);
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('deletes the profile again when the membership cannot be written', async () => {
    const { service, fake } = build({ registerFails: new Error('permission denied') });

    // Returning an account that authenticates and then fails every request is
    // the bug. Failing outright is the honest outcome.
    await expect(runWithTenant(ACME, () => service.createUser(dto))).rejects.toThrow(
      'permission denied',
    );

    expect(fake.deleted).toHaveLength(1);
  });

  it('reports the original failure even if the rollback also fails', async () => {
    const fake = fakeDb();
    fake.db.delete = () => ({
      where: async () => {
        throw new Error('rollback failed');
      },
    });
    const { service } = build({ db: fake, registerFails: new Error('permission denied') });

    await expect(runWithTenant(ACME, () => service.createUser(dto))).rejects.toThrow(
      'permission denied',
    );

    // The orphan is unusable and invisible, so it has to be findable in the log.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mate@acme.test'));
  });

  it('refuses outside a tenant context, before anything is created', async () => {
    const { service } = build();

    await expect(service.createUser(dto)).rejects.toThrow(/tenant/i);

    // Nothing half-created: no SuperTokens identity left behind for an email
    // that has no profile anywhere.
    expect(signUpSpy).not.toHaveBeenCalled();
  });

  it('does not register a membership for a username that already exists', async () => {
    const { service, membership } = build({ db: fakeDb({ existingUsernames: ['mate@acme.test'] }) });

    await expect(runWithTenant(ACME, () => service.createUser(dto))).rejects.toThrow(
      /already exists/,
    );

    expect(membership.register).not.toHaveBeenCalled();
  });

  it('does not register a membership when the identity already exists elsewhere', async () => {
    signUpSpy.mockResolvedValue({ status: 'EMAIL_ALREADY_EXISTS_ERROR' } as never);
    const { service, membership } = build();

    await expect(runWithTenant(ACME, () => service.createUser(dto))).rejects.toThrow(
      /already exists/,
    );

    // Mapping an identity we did not create would move someone else's login
    // onto this tenant.
    expect(membership.register).not.toHaveBeenCalled();
  });
});
