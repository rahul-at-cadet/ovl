import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { initTRPC, TRPCError } from '@trpc/server';
import { httpExceptionMapper } from './http-error.middleware';

/**
 * The services throw Nest exceptions and tRPC codes anything that is not
 * a TRPCError as INTERNAL_SERVER_ERROR — so every one of these used to
 * reach the client as a 500 with a stack trace. A caller could not tell
 * "you asked for something that isn't there" from "the server is broken",
 * and monitoring counted ordinary user mistakes as server faults.
 */
function callerFor(thrower: () => unknown) {
  const t = initTRPC.create();
  const router = t.router({
    run: t.procedure.use(httpExceptionMapper(t)).query(() => thrower()),
  });
  return router.createCaller({});
}

async function codeOf(thrower: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await callerFor(thrower).run();
    throw new Error('expected the procedure to throw');
  } catch (e: any) {
    return { code: e.code, message: e.message };
  }
}

describe('httpExceptionMapper', () => {
  it('maps a missing resource to NOT_FOUND', async () => {
    expect(await codeOf(() => { throw new NotFoundException('Report not found'); })).toEqual({
      code: 'NOT_FOUND',
      message: 'Report not found',
    });
  });

  it('maps a rejected input to BAD_REQUEST', async () => {
    expect((await codeOf(() => { throw new BadRequestException('minReportIntervalHours must be > 0'); })).code).toBe(
      'BAD_REQUEST',
    );
  });

  it('maps a conflict to CONFLICT', async () => {
    // A section held by a colleague, or a report already submitted once.
    // Retrying these is pointless, which is precisely what a 409 says and
    // a 500 does not.
    expect((await codeOf(() => { throw new ConflictException('Section "Bunker" is being edited by chief'); })).code).toBe(
      'CONFLICT',
    );
  });

  it('maps a permission failure to FORBIDDEN', async () => {
    expect((await codeOf(() => { throw new ForbiddenException('Only the Master account may manage backups'); })).code).toBe(
      'FORBIDDEN',
    );
  });

  it('leaves a genuine fault as INTERNAL_SERVER_ERROR', async () => {
    // The point is not to relabel everything. A real bug must keep
    // saying it is one.
    expect((await codeOf(() => { throw new Error('cannot read property of undefined'); })).code).toBe(
      'INTERNAL_SERVER_ERROR',
    );
  });

  it('leaves an existing TRPCError untouched', async () => {
    expect(await codeOf(() => { throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no restore key' }); })).toEqual(
      { code: 'PRECONDITION_FAILED', message: 'no restore key' },
    );
  });

  it('passes an unmapped HTTP status through rather than guessing', async () => {
    // 402 has no tRPC equivalent. Inventing one would be worse than
    // reporting a fault.
    expect((await codeOf(() => { throw new HttpException('teapot', 418); })).code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('keeps the message from a structured exception payload', async () => {
    // The validation path throws { message, errors } and the report form
    // renders those field-level errors against individual inputs.
    const { code, message } = await codeOf(() => {
      throw new BadRequestException({ message: 'Validation failed', errors: [{ field: 'Bunker_Port' }] });
    });
    expect(code).toBe('BAD_REQUEST');
    expect(message).toBe('Validation failed');
  });

  it('does not disturb a successful call', async () => {
    const t = initTRPC.create();
    const router = t.router({ run: t.procedure.use(httpExceptionMapper(t)).query(() => ({ fine: true })) });
    await expect(router.createCaller({}).run()).resolves.toEqual({ fine: true });
  });

  it('covers the statuses the services actually raise', async () => {
    for (const [status, expected] of [
      [HttpStatus.BAD_REQUEST, 'BAD_REQUEST'],
      [HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED'],
      [HttpStatus.FORBIDDEN, 'FORBIDDEN'],
      [HttpStatus.NOT_FOUND, 'NOT_FOUND'],
      [HttpStatus.CONFLICT, 'CONFLICT'],
      [HttpStatus.PRECONDITION_FAILED, 'PRECONDITION_FAILED'],
      [HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE'],
      [HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS'],
    ] as [number, string][]) {
      expect((await codeOf(() => { throw new HttpException('x', status); })).code).toBe(expected);
    }
  });
});
