import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { currentTenant, type TenantContext } from './tenant-context';

/**
 * Injects the active tenant into a handler parameter.
 *
 *   @Get()
 *   @UseGuards(AuthGuard, TenantGuard)
 *   list(@CurrentTenant() tenant: TenantContext) { ... }
 *
 * Reads from AsyncLocalStorage rather than from the request object on purpose:
 * there is then exactly one source of truth for "which tenant is this?", and
 * the value a controller sees is provably the same one TenantDbService will
 * bind the connection to. Two parallel copies of that answer is how they end
 * up disagreeing.
 *
 * For logging and other places where absence is acceptable, call
 * `tryCurrentTenant()` directly instead.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): TenantContext => currentTenant(),
);
