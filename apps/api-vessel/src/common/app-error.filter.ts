import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, ERROR_KIND_MAPPING } from './app-error';

/**
 * Expresses a domain error over HTTP, for the REST controllers.
 *
 * The other half of the same job rpc/domain-error.middleware.ts does for
 * tRPC. Both read ERROR_KIND_MAPPING, so a NotFoundError is a 404 here
 * and a NOT_FOUND there without either side deciding for itself.
 *
 * Without this filter, a service throwing a domain error instead of
 * Nest's NotFoundException would surface as a 500 on the REST routes —
 * which is exactly the bug being fixed, just moved.
 */
@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);

  catch(exception: AppError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const { httpStatus } = ERROR_KIND_MAPPING[exception.kind];

    // Logged at debug: these are expected outcomes, not incidents. The
    // whole point of the change is that an ordinary "not found" stops
    // being reported as a server fault.
    this.logger.debug(`${exception.kind}: ${exception.message}`);

    response.status(httpStatus).json({
      statusCode: httpStatus,
      message: exception.message,
      // Field-level detail when there is any — the report form renders
      // these against individual inputs.
      ...(exception.details !== undefined ? { details: exception.details } : {}),
    });
  }
}
