import { HttpException } from '@nestjs/common';
import { TRPCError } from '@trpc/server';

/**
 * Translates the Nest exceptions services throw into tRPC error codes.
 *
 * Kept in step with apps/api-vessel/src/rpc/http-error.middleware.ts;
 * the two apps share no code and both routers need this.
 *
 * The services are shared between the tRPC router and the REST
 * controllers, so they signal failure the Nest way — NotFoundException,
 * ConflictException, BadRequestException. tRPC understands none of those:
 * anything that is not a TRPCError becomes INTERNAL_SERVER_ERROR, so
 * publishing an invalid schema, or saving a cadence rule with a
 * nonsensical interval, reached the client as a 500 with a stack trace
 * attached rather than as the rejection it is.
 *
 * That is worse than untidy. A client cannot tell "you asked for
 * something that isn't there" from "the server is broken", so it cannot
 * decide whether retrying makes sense; and error monitoring counts every
 * ordinary user mistake as a server fault, which buries the real ones.
 *
 * Only exceptions carrying an HTTP status are remapped. Anything else is
 * left as INTERNAL_SERVER_ERROR, because a genuine fault should keep
 * saying so.
 */
const HTTP_STATUS_TO_TRPC: Record<number, TRPCError['code']> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_SUPPORTED',
  408: 'TIMEOUT',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_CONTENT',
  429: 'TOO_MANY_REQUESTS',
  499: 'CLIENT_CLOSED_REQUEST',
  501: 'NOT_IMPLEMENTED',
};

/**
 * Nest's exception payload is a string for a bare `new
 * BadRequestException('...')` and an object for the structured form
 * (`{ message, errors }`). Both have to survive, so a caller keeps
 * whatever detail the service provided.
 */
function describe(exception: HttpException): { message: string; payload: unknown } {
  const response = exception.getResponse();
  if (typeof response === 'string') return { message: response, payload: undefined };
  const body = response as { message?: unknown };
  const message = typeof body.message === 'string' ? body.message : exception.message;
  return { message, payload: response };
}

/**
 * The shape this needs from a tRPC root, described structurally rather
 * than as `ReturnType<typeof initTRPC.create>`.
 *
 * That signature only matched a root built without a context type, so
 * passing one from `initTRPC.context<Context>().create()` failed to
 * compile — and only under `next build`, which type-checks the routers
 * through the imported AppRouter. `nest start` never surfaced it.
 * Constraining to the one method used keeps both roots assignable while
 * preserving the middleware's own return type for `.use()`.
 */
interface TrpcRootWithMiddleware {
  middleware: (fn: (opts: { next: () => Promise<any> }) => Promise<any>) => any;
}

export function httpExceptionMapper<T extends TrpcRootWithMiddleware>(t: T): ReturnType<T['middleware']> {
  return t.middleware(async ({ next }) => {
    const result = await next();
    if (result.ok) return result;

    const cause = result.error.cause;
    if (!(cause instanceof HttpException)) return result;

    const code = HTTP_STATUS_TO_TRPC[cause.getStatus()];
    if (!code) return result;

    const { message, payload } = describe(cause);
    // Thrown rather than returned: the error's code is fixed by the time
    // a middleware sees the result, so replacing it means raising a new
    // one. `cause` is kept so the original is still available to logging.
    throw new TRPCError({ code, message, cause: payload === undefined ? cause : Object.assign(cause, { payload }) });
  });
}
