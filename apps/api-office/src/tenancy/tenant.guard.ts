import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { tryCurrentTenant } from './tenant-context';

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
  canActivate(_context: ExecutionContext): boolean {
    if (!tryCurrentTenant()) {
      throw new ForbiddenException('No tenant is associated with this account.');
    }
    return true;
  }
}
