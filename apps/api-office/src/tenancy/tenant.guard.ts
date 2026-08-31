import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { tryCurrentTenant } from './tenant-context';
import { NO_TENANT_MESSAGE, TENANT_CONFLICT } from './tenant.middleware';

/**
 * Refuses any request that has no tenant on its async context.
 *
 * The database binding already fails closed — `currentTenant()` throws inside
 * TenantDbService, so an unscoped request cannot read tenant data whether this
 * guard runs or not. What the guard adds is the right *answer*: a clear 403 at
 * the edge instead of a 500 from somewhere in the service layer.
 *
 * Use it alongside AuthGuard, never instead of it: AuthGuard establishes who
 * the caller is, this one establishes that they belong somewhere.
 *
 *   @UseGuards(AuthGuard, TenantGuard)
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Checked before the generic case: an identity holding both a membership
    // and a super admin grant has a tenant it could be served and is refused
    // anyway, so "no tenant is associated with this account" would be both
    // untrue and useless for working out what to do about it.
    const conflict = context.switchToHttp().getRequest()?.[TENANT_CONFLICT];
    if (typeof conflict === 'string') throw new ForbiddenException(conflict);

    if (!tryCurrentTenant()) {
      throw new ForbiddenException(NO_TENANT_MESSAGE);
    }
    return true;
  }
}
