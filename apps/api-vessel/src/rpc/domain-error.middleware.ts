import { HttpException } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import { ERROR_KIND_MAPPING, isAppError } from '../common/app-error';
import { NotFoundError } from '../common/app-error';

/**
 * Expresses a domain error over tRPC.
 *
 * tRPC codes anything that is not a TRPCError as INTERNAL_SERVER_ERROR,
 * so before this every domain failure arrived as a 500 — a client could
 * not tell "that does not exist" from "the server is broken", and
 * monitoring counted ordinary mistakes as faults.
 *
 * A middleware, rather than the more obvious `errorFormatter`, because
 * errorFormatter cannot do the job: it shapes the response body only,
 * and the code — which is also what getHTTPStatusCodeFromError reads —
 * is already fixed by the time it runs. Verified, not assumed.
 *
 * The mapping itself lives in common/app-error.ts, read by the REST
 * exception filter too, so the two transports cannot disagree about the
 * same error.
 */

/**
 * Controllers legitimately throw HTTP exceptions — they *are* transport
 * code. Only the services were wrong to. This covers that half, and any
 * Nest exception raised by a guard or pipe.
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
  501: 'NOT_IMPLEMENTED',
};

/**
 * Nest's payload is a string for `new NotFoundError('...')` and an
 * object for the structured form. Both have to survive so a caller keeps
 * whatever detail was provided.
 */
function describeHttpException(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const body = response as { message?: unknown };
  return typeof body.message === 'string' ? body.message : exception.message;
}

/**
 * The shape this needs from a tRPC root, described structurally rather
 * than as `ReturnType<typeof initTRPC.create>`.
 *
 * That signature only matched a root built without a context type, so
 * passing one from `initTRPC.context<Context>().create()` failed to
 * compile — and only under `next build`, which type-checks the routers
 * through the imported AppRouter. `nest start` never surfaced it.
 */
interface TrpcRootWithMiddleware {
  middleware: (fn: (opts: { next: () => Promise<any> }) => Promise<any>) => any;
}

export function domainErrorMapper<T extends TrpcRootWithMiddleware>(t: T): ReturnType<T['middleware']> {
  return t.middleware(async ({ next }) => {
    const result = await next();
    if (result.ok) return result;

    const cause = result.error.cause;

    // A domain error knows its own kind, so no protocol translation is
    // guessed here — the shared table answers it.
    if (isAppError(cause)) {
      throw new TRPCError({
        code: ERROR_KIND_MAPPING[cause.kind].trpcCode as TRPCError['code'],
        message: cause.message,
        cause,
      });
    }

    if (cause instanceof HttpException) {
      const code = HTTP_STATUS_TO_TRPC[cause.getStatus()];
      // An unmapped status is left as a fault rather than guessed at:
      // inventing a code would be worse than reporting a problem.
      if (code) throw new TRPCError({ code, message: describeHttpException(cause), cause });
    }

    // Anything else is a genuine fault and must keep saying so.
    return result;
  });
}
