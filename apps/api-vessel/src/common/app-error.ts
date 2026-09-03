/**
 * Transport-agnostic domain errors.
 *
 * The services used to throw Nest's HTTP exceptions — NotFoundException,
 * ConflictException — which are `@nestjs/common` types describing an
 * HTTP response. That was wrong twice over. The domain layer has no
 * business knowing about HTTP, and this app serves the same services
 * over two transports: REST controllers, where Nest translates those
 * exceptions natively, and tRPC, which does not understand them at all
 * and coded every single one as INTERNAL_SERVER_ERROR. A missing report
 * and a real crash were indistinguishable to a client.
 *
 * So a service now says what went wrong in its own terms and each
 * transport decides how to express it. Crucially both read the one table
 * below, so they cannot drift into disagreeing about the same failure.
 *
 * Kept in step with apps/api-office/src/common/app-error.ts. The two
 * apps deploy independently and share no code — the same arrangement
 * password.ts and the DR crypto already use.
 */

/**
 * What kind of failure this is, in domain terms rather than protocol
 * ones. Deliberately a small closed set: every value has to mean
 * something distinct to a caller deciding whether to retry, fix its
 * input, or give up.
 */
export type ErrorKind =
  /** The thing asked for does not exist. */
  | 'notFound'
  /** The request was understood and is not acceptable. */
  | 'invalid'
  /** Valid, but incompatible with the current state — retrying as-is will not help. */
  | 'conflict'
  /** The caller is known and not allowed. */
  | 'forbidden'
  /** The caller is not identified. */
  | 'unauthorized'
  /** Something must happen first before this can succeed. */
  | 'precondition';

/**
 * The single mapping both transports consult.
 *
 * One table rather than one per transport: the tRPC middleware and the
 * Nest exception filter answer the same question, and two tables would
 * eventually give two different answers for the same error.
 */
export const ERROR_KIND_MAPPING: Record<ErrorKind, { trpcCode: string; httpStatus: number }> = {
  notFound: { trpcCode: 'NOT_FOUND', httpStatus: 404 },
  invalid: { trpcCode: 'BAD_REQUEST', httpStatus: 400 },
  conflict: { trpcCode: 'CONFLICT', httpStatus: 409 },
  forbidden: { trpcCode: 'FORBIDDEN', httpStatus: 403 },
  unauthorized: { trpcCode: 'UNAUTHORIZED', httpStatus: 401 },
  precondition: { trpcCode: 'PRECONDITION_FAILED', httpStatus: 412 },
};

export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /**
     * Extra structure a caller needs. The validation path carries
     * field-level errors here, which the report form renders against
     * individual inputs — losing them would leave an officer with
     * "Validation failed" and nothing to act on.
     */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super('notFound', message, details);
  }
}

export class InvalidInputError extends AppError {
  constructor(message: string, details?: unknown) {
    super('invalid', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super('forbidden', message, details);
  }
}

export class PreconditionError extends AppError {
  constructor(message: string, details?: unknown) {
    super('precondition', message, details);
  }
}

/**
 * Recognises a domain error without `instanceof`.
 *
 * There is one hoisted copy of every dependency today, so `instanceof`
 * would work — but it silently stops working the moment a package is
 * duplicated in the tree, and the failure mode is an error quietly
 * reverting to a 500. Checking the shape costs nothing and cannot break
 * that way.
 */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind in ERROR_KIND_MAPPING;
}
