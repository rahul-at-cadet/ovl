import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { initTRPC, TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import {
  ConflictError,
  ERROR_KIND_MAPPING,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  PreconditionError,
  isAppError,
} from '../common/app-error';
import { domainErrorMapper } from './domain-error.middleware';

/**
 * Services raise domain errors; tRPC codes anything that is not a
 * TRPCError as INTERNAL_SERVER_ERROR. Without this mapping a missing
 * report and a genuine crash are the same thing to a client, and
 * monitoring counts ordinary mistakes as faults.
 */
function router(thrower: () => unknown) {
  const t = initTRPC.create({
    errorFormatter({ shape, error }) {
      const cause = error.cause;
      if (isAppError(cause) && cause.details !== undefined) {
        return { ...shape, data: { ...shape.data, details: cause.details } };
      }
      return shape;
    },
  });
  return t.router({ run: t.procedure.use(domainErrorMapper(t)).query(() => thrower()) });
}

async function raise(thrower: () => unknown) {
  try {
    await router(thrower).createCaller({}).run();
    throw new Error('expected a throw');
  } catch (e: any) {
    return e as TRPCError;
  }
}

describe('domain errors over tRPC', () => {
  it.each([
    [() => new NotFoundError('Report not found'), 'NOT_FOUND', 404],
    [() => new InvalidInputError('minReportIntervalHours must be > 0'), 'BAD_REQUEST', 400],
    [() => new ConflictError('Section is being edited by chief'), 'CONFLICT', 409],
    [() => new ForbiddenError('Only the Master account may manage backups'), 'FORBIDDEN', 403],
    [() => new PreconditionError('no restore key on file'), 'PRECONDITION_FAILED', 412],
  ] as [() => Error, string, number][])(
    'maps %# to the code and HTTP status the shared table declares',
    async (make, code, status) => {
      const err = await raise(() => { throw make(); });
      expect(err.code).toBe(code);
      // The status the transport would actually send, not just the label.
      expect(getHTTPStatusCodeFromError(err)).toBe(status);
    },
  );

  it('agrees with the table the REST filter reads', () => {
    // One table, two transports. Two tables would eventually give two
    // different answers for the same failure.
    expect(ERROR_KIND_MAPPING.notFound).toEqual({ trpcCode: 'NOT_FOUND', httpStatus: 404 });
    expect(Object.keys(ERROR_KIND_MAPPING).sort()).toEqual(
      ['conflict', 'forbidden', 'invalid', 'notFound', 'precondition', 'unauthorized'],
    );
  });

  it('carries field-level details through to the client', async () => {
    // The old mapper read only the summary message, so over tRPC these
    // were dropped entirely and a form had nothing to attach to inputs —
    // even though the REST side received the whole payload.
    const err = await raise(() => {
      throw new InvalidInputError('Validation failed', { errors: ['Bunker Port is required'] });
    });
    expect(err.code).toBe('BAD_REQUEST');
    expect((err.cause as any).details).toEqual({ errors: ['Bunker Port is required'] });
  });

  it('still understands the HTTP exceptions controllers legitimately throw', async () => {
    // Controllers are transport code, so NotFoundException is correct
    // there; guards and pipes raise them too.
    expect((await raise(() => { throw new NotFoundException('no such attachment'); })).code).toBe('NOT_FOUND');
    expect((await raise(() => { throw new BadRequestException('confirm must be true'); })).code).toBe('BAD_REQUEST');
  });

  it('leaves a genuine fault as INTERNAL_SERVER_ERROR', async () => {
    // The point is not to relabel everything. A real bug keeps saying so.
    expect((await raise(() => { throw new Error('cannot read property of undefined'); })).code).toBe(
      'INTERNAL_SERVER_ERROR',
    );
  });

  it('does not invent a code for an unmapped HTTP status', async () => {
    expect((await raise(() => { throw new HttpException('teapot', 418); })).code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('leaves an existing TRPCError alone', async () => {
    const err = await raise(() => { throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'slow down' }); });
    expect(err.code).toBe('TOO_MANY_REQUESTS');
  });

  it('does not disturb a successful call', async () => {
    await expect(router(() => ({ fine: true })).createCaller({}).run()).resolves.toEqual({ fine: true });
  });

  it('recognises a domain error without instanceof', () => {
    // instanceof works today because every dependency is hoisted once,
    // but it stops working silently the moment one is duplicated — and
    // the failure mode is an error quietly reverting to a 500.
    const acrossModuleBoundary = { kind: 'notFound', message: 'from another copy of the module' };
    expect(isAppError(acrossModuleBoundary)).toBe(true);
    expect(isAppError({ kind: 'nonsense' })).toBe(false);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
