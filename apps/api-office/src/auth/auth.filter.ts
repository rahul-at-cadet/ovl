import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Error as STError } from 'supertokens-node';
import { errorHandler } from 'supertokens-node/framework/express';

@Catch(STError)
export class SupertokensExceptionFilter implements ExceptionFilter {
    handler: any;

    constructor() {
        this.handler = errorHandler();
    }

    catch(exception: Error, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const res = ctx.getResponse();
        const req = ctx.getRequest();

        // AuthGuard throws a synthetic "RESPONSE_SENT" STError when
        // verifySession() has already fully written the HTTP response
        // itself (e.g. an expired session needing a refresh) without
        // passing a real error to its callback. supertokens' errorHandler()
        // doesn't recognize that made-up type, so it falls through to
        // Express's default error handling, which logs the stack trace to
        // stderr on every occurrence even though nothing is actually
        // wrong — the real response already went out. Since there's
        // nothing left to send, stop here instead of letting that noise
        // through.
        if (res.headersSent) {
            return;
        }

        return this.handler(exception, req, res, ctx.getNext());
    }
}
