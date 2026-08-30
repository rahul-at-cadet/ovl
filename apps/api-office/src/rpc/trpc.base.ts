import { initTRPC, TRPCError } from '@trpc/server';
import * as trpcExpress from '@trpc/server/adapters/express';
import * as crypto from 'crypto';
import Session from 'supertokens-node/recipe/session';
import { tryCurrentTenant } from '../tenancy/tenant-context';
import type { AuditActor } from '../audit/audit.service';

/**
 * Shared tRPC primitives for the office API.
 *
 * Extracted so each domain router can live in its own file. `initTRPC` must be
 * called exactly once — every procedure and router in the app has to come from
 * the same builder or their types will not compose — so this module is the one
 * place that does it, and everything else imports from here.
 */

export const createContext = ({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions) => {
  return {
    req,
    res,
  };
};

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const publicProcedure = t.procedure;
export const router = t.router;

/**
 * Builds an in-process caller for a router.
 *
 * Exported for the sync contract tests, which drive the real edge and sync
 * procedures — authentication included — against a live database without
 * standing up an HTTP server. The alternative, asserting against mocks, would
 * only prove the mocks behave as the test expects, and the properties that
 * matter here (a key verified in the right schema, a cascade committing with
 * the version that triggered it) are exactly the ones a mock cannot show.
 */
export const createCallerFactory = t.createCallerFactory;

const isEdgeAuthed = t.middleware(async ({ ctx, next }) => {
  const authHeader = ctx.req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ovl_prod_')) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing or malformed API key' });
  }

  const rawToken = authHeader.split('Bearer ovl_prod_')[1];
  const tokenLookupHash = crypto.createHash('sha256').update(rawToken.substring(0, 8)).digest('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // We can't access `this.db` directly here because it's inside the TrpcRouter class.
  // We will pass the db to the middleware inside the router class!
  return next({
    ctx: {
      ...ctx,
      tokenHash,
      tokenLookupHash,
    },
  });
});

export const edgeProcedure = t.procedure.use(isEdgeAuthed);

/**
 * Verifies the SuperTokens session on the underlying Express req/res
 * (mirrors AuthGuard's REST-side check — the tRPC router is mounted via raw
 * app.use(), so Nest's @UseGuards() never runs for it; this is the only
 * place session verification happens for tRPC traffic).
 *
 * Deliberately uses Session.getSession() (the plain function), not the
 * verifySession() Express middleware: verifySession() is designed to be a
 * terminal middleware and writes a 401 response directly to `res` on
 * failure, which crashes the server here ("write after end") since tRPC's
 * Express adapter also tries to write a response to the same `res` once
 * this middleware throws. getSession() just throws without touching `res`.
 *
 * Loading the full local Postgres user (for role checks) happens
 * per-procedure via the injected SupertokensService, not here, since this
 * middleware is defined at module scope before DI has constructed it.
 */
const isAuthed = t.middleware(async ({ ctx, next }) => {
  try {
    const session = await Session.getSession(ctx.req, ctx.res);
    return next({ ctx: { ...ctx, session } });
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not logged in' });
  }
});

export const protectedProcedure = t.procedure.use(isAuthed);

/**
 * Throws unless the tenancy/catalogue stack is wired up.
 *
 * Those providers only exist when MULTI_TENANCY_ENABLED is set, so procedures
 * that need them say so plainly rather than dereferencing undefined.
 */
export function requireCatalogue<T>(service: T | undefined): T {
  if (!service) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The form-schema catalogue requires MULTI_TENANCY_ENABLED=true.',
    });
  }
  return service;
}

/** The active tenant, or a clean 403 rather than a 500 from deeper down. */
export function requireTenant() {
  const tenant = tryCurrentTenant();
  if (!tenant) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'No tenant is associated with this account.',
    });
  }
  return tenant;
}

/**
 * The request facts an audit row needs and a service cannot know.
 *
 * `req.ip` honours Express's `trust proxy` setting, so behind the nginx in
 * deploy/ it is the client address rather than the proxy's — provided that
 * setting is on. Where it is not, this records the hop in front, which is
 * still more useful than recording nothing and is why the value is stored as
 * text rather than as `inet`.
 */
export function auditMeta(ctx: Context): {
  ip: string | null;
  userAgent: string | null;
} {
  const userAgent = ctx.req.headers['user-agent'];
  return {
    ip: ctx.req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

/**
 * The same facts as `auditMeta`, plus who the caller is.
 *
 * The id is the SuperTokens one, from the session the `isAuthed` middleware
 * has already verified — matching what the REST side's `@Actor()` decorator
 * produces, so one log can be read across both transports.
 */
export function auditActor(
  ctx: Context & { session?: { getUserId(): string } },
  email?: string | null,
): AuditActor {
  return {
    userId: ctx.session?.getUserId() ?? null,
    email: email ?? null,
    ...auditMeta(ctx),
  };
}
