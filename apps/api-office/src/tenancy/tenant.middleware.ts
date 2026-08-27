import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Session from 'supertokens-node/recipe/session';
import { TenantRegistryService } from './tenant-registry.service';
import { runWithTenant } from './tenant-context';

/** Set when a session was present but resolved to no usable tenant. */
export const TENANT_UNRESOLVED = Symbol('ovl.tenantUnresolved');

/**
 * Establishes the tenant context for the rest of the request.
 *
 * Placed in middleware rather than a guard or interceptor because the
 * AsyncLocalStorage scope has to wrap *everything* downstream — guards,
 * interceptors, pipes, the handler and its async continuations. Nest runs
 * middleware first, so `next()` called inside `runWithTenant` puts the whole
 * remaining chain on the context.
 *
 * Two properties worth stating plainly:
 *
 * The tenant is derived from the authenticated session and from nothing else.
 * No header, query parameter or body field participates. A subdomain or an
 * `X-Tenant-Id` header may look convenient, but either would let a caller
 * nominate the tenant they want, turning authentication into a formality.
 *
 * This middleware never rejects a request. It resolves a tenant when it can
 * and steps aside when it cannot — authentication failures belong to AuthGuard
 * and tenancy failures to TenantGuard, both of which produce the correct
 * status codes. A middleware that also rejected would duplicate that logic and
 * drift from it.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);

  constructor(private readonly registry: TenantRegistryService) {}

  async use(req: any, res: any, next: (err?: unknown) => void): Promise<void> {
    const supertokensUserId = await this.readUserId(req, res);

    if (!supertokensUserId) {
      // Unauthenticated, or an auth route. No tenant, and that is fine —
      // anything that needs one will fail loudly when it asks.
      next();
      return;
    }

    let descriptor;
    try {
      descriptor = await this.registry.forUser(supertokensUserId);
    } catch (error) {
      next(error);
      return;
    }

    if (!descriptor) {
      // Authenticated but unmapped, or mapped to a suspended tenant. Flagged
      // rather than thrown so TenantGuard can answer with 403 and so tRPC can
      // answer with FORBIDDEN, each in its own idiom.
      this.logger.warn(`No active tenant for SuperTokens user ${supertokensUserId}`);
      req[TENANT_UNRESOLVED] = true;
      next();
      return;
    }

    runWithTenant(
      {
        ...descriptor,
        requestId: (req.headers?.['x-request-id'] as string) || randomUUID(),
      },
      () => next(),
    );
  }

  /**
   * Reads the SuperTokens user id without requiring a session.
   *
   * `sessionRequired: false` matters: this middleware runs on every route
   * including `/auth/*` and the health check, and must not turn an anonymous
   * request into a 401. Session verification proper — with the right error
   * semantics — stays in AuthGuard and in the tRPC `isAuthed` middleware.
   *
   * Errors are swallowed for the same reason. An expired token here means "no
   * tenant yet"; it is AuthGuard's job to tell the client to refresh, and this
   * middleware writing to `res` would collide with that.
   */
  private async readUserId(req: any, res: any): Promise<string | null> {
    try {
      const session = await Session.getSession(req, res, { sessionRequired: false });
      return session?.getUserId() ?? null;
    } catch {
      return null;
    }
  }
}
