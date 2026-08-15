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
        
        return this.handler(exception, req, res, ctx.getNext());
    }
}
