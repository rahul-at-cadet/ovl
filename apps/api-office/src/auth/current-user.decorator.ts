import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { LocalUser } from './supertokens.service';

/**
 * Extracts the authenticated local Postgres user from the request,
 * as attached by AuthGuard after session verification.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): LocalUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
