import { ForbiddenException } from '@nestjs/common';
import Session from 'supertokens-node/recipe/session';
import {
  NO_TENANT_MESSAGE,
  TenantMiddleware,
  TENANT_CONFLICT,
  TENANT_UNRESOLVED,
} from './tenant.middleware';
import { TenantGuard } from './tenant.guard';
import { ConflictingIdentityError, TenantRegistryService } from './tenant-registry.service';

/**
 * How a conflicting identity is reported, as distinct from how it is detected.
 *
 * Detection is exercised against a real database in
 * `identity-exclusivity.integration.spec.ts`. What is left is the part that has
 * bitten once already: the refusal has to arrive as something the caller can
 * render. An error thrown out of the middleware escapes into Express's own
 * handler on the bare `/trpc` mount and comes back in a shape no tRPC client
 * can parse, so the browser shows an empty screen rather than a refusal — which
 * is the failure mode the whole rule exists to remove.
 */
describe('reporting a conflicting identity', () => {
  const message = 'Identity u1 is both a member of tenant acme and a platform super admin.';

  const registryThatThrows = (error: Error): TenantRegistryService =>
    ({ forUser: jest.fn().mockRejectedValue(error) }) as unknown as TenantRegistryService;

  beforeEach(() => {
    jest
      .spyOn(Session, 'getSession')
      .mockImplementation(async () => ({ getUserId: () => 'u1' }) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('TenantMiddleware', () => {
    it('flags the conflict on the request instead of rejecting', async () => {
      const middleware = new TenantMiddleware(
        registryThatThrows(new ConflictingIdentityError('u1', 'acme')),
      );
      const req: any = { headers: {} };
      const next = jest.fn();

      await middleware.use(req, {}, next);

      expect(next).toHaveBeenCalledWith();
      expect(req[TENANT_CONFLICT]).toContain('both a member of tenant acme');
    });

    it('keeps the conflict distinct from an ordinary unresolved tenant', async () => {
      const middleware = new TenantMiddleware(
        registryThatThrows(new ConflictingIdentityError('u1', 'acme')),
      );
      const req: any = { headers: {} };

      await middleware.use(req, {}, jest.fn());

      // Answering "no tenant is associated with this account" here would be
      // untrue — there is one, and it is deliberately not being served.
      expect(req[TENANT_UNRESOLVED]).toBeUndefined();
    });

    it('still hands any other resolution failure to the error chain', async () => {
      const boom = new Error('registry unreachable');
      const middleware = new TenantMiddleware(registryThatThrows(boom));
      const req: any = { headers: {} };
      const next = jest.fn();

      await middleware.use(req, {}, next);

      expect(next).toHaveBeenCalledWith(boom);
      expect(req[TENANT_CONFLICT]).toBeUndefined();
    });
  });

  describe('TenantGuard', () => {
    const contextFor = (req: unknown) =>
      ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;

    it('answers with the conflict message rather than the generic one', () => {
      const req: Record<symbol, string> = { [TENANT_CONFLICT]: message };
      expect(() => new TenantGuard().canActivate(contextFor(req))).toThrow(ForbiddenException);
      expect(() => new TenantGuard().canActivate(contextFor(req))).toThrow(message);
    });

    it('still gives the generic answer when there is simply no tenant', () => {
      expect(() => new TenantGuard().canActivate(contextFor({}))).toThrow(
        NO_TENANT_MESSAGE,
      );
    });
  });
});
