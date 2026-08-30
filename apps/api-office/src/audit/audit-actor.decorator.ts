import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuditActor } from './audit.service';

/**
 * Who is making this request, in the shape the audit log wants.
 *
 * A decorator rather than four lines in each controller method, because those
 * four lines are exactly the sort that drift: one endpoint records the
 * SuperTokens id, the next records the local row's uuid, and the log ends up
 * with two kinds of actor that cannot be joined to each other.
 *
 * The id is always the SuperTokens one, taken from the verified session that
 * AuthGuard has already established — the same identity `platform.super_admins`
 * and `platform.tenant_users` are keyed by. The local profile contributes only
 * the email, and only because it is the readable half.
 */
export const Actor = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuditActor => {
  const req = ctx.switchToHttp().getRequest();
  const userAgent = req.headers?.['user-agent'];

  return {
    userId: req.session?.getUserId?.() ?? null,
    email: req.user?.username ?? null,
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
});
