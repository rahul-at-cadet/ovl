import { TRPCError } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { protectedProcedure, router, requireTenant } from './trpc.base';
import { AUDIT_EVENT_CLASSES } from '@ovl/database';
import { AuditService } from '../audit/audit.service';
import { PlatformDbService } from '../tenancy/platform-db.service';
import { SupertokensService } from '../auth/supertokens.service';

/**
 * Reading the audit log.
 *
 * Two audiences, and the difference between them is the whole security
 * property of this router. A platform super admin sees every tenant's events,
 * because they are the one identity that can act inside every tenant. A
 * tenant's own admin sees only their tenant's, and cannot ask for anything
 * else: the filter is not taken from the request, it is imposed from the
 * tenant the session already resolved to.
 *
 * That is deliberately the same rule the rest of the app follows — a caller
 * who can name their own tenant has turned authentication into a formality —
 * applied to the one table that spans every tenant.
 *
 * Dependencies arrive as a getter; see notifications.router.ts for why.
 */
export interface AuditRouterDeps {
  audit?: AuditService;
  platformDb?: PlatformDbService;
  supertokensService: SupertokensService;
}

const ListSchema = Type.Object({
  /**
   * Super admin only. Ignored for everyone else, whose events are confined to
   * their own tenant no matter what they ask for.
   */
  tenantId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  eventClass: Type.Optional(
    Type.Union(AUDIT_EVENT_CLASSES.map((value) => Type.Literal(value))),
  ),
  before: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const ListCompiler = TypeCompiler.Compile(ListSchema);

export function createAuditRouter(deps: () => AuditRouterDeps) {
  return router({
    /**
     * Whether this caller may read a log at all, and how much of one.
     *
     * Separate from `list` so the page can render "you have no access here"
     * without first issuing a query that would be refused — and so the nav
     * can decide whether to offer the screen.
     */
    capabilities: protectedProcedure.query(async ({ ctx }) => {
      const d = deps();
      const userId = ctx.session.getUserId();
      const isSuperAdmin = d.platformDb ? await d.platformDb.isSuperAdmin(userId) : false;
      const localUser = await d.supertokensService.getLocalUser(userId);
      const isTenantAdmin = ((localUser?.roles as string[] | undefined) ?? []).includes('admin');

      return {
        available: Boolean(d.audit),
        // A super admin reads across tenants; a tenant admin reads one.
        canReadAllTenants: isSuperAdmin,
        canRead: isSuperAdmin || isTenantAdmin,
      };
    }),

    list: protectedProcedure
      .input((val: unknown) => {
        if (!ListCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof ListSchema>;
      })
      .query(async ({ input, ctx }) => {
        const d = deps();
        if (!d.audit) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The audit log requires MULTI_TENANCY_ENABLED=true.',
          });
        }

        const userId = ctx.session.getUserId();
        const isSuperAdmin = d.platformDb ? await d.platformDb.isSuperAdmin(userId) : false;

        if (isSuperAdmin) {
          // The only caller whose tenant filter comes from the request, and
          // the only one for whom that is safe: they may already act in every
          // tenant, so naming one reveals nothing they could not reach.
          return d.audit.list({
            tenantId: input.tenantId,
            eventClass: input.eventClass,
            before: input.before,
            limit: input.limit,
          });
        }

        const localUser = await d.supertokensService.getLocalUser(userId);
        if (!((localUser?.roles as string[] | undefined) ?? []).includes('admin')) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Reading the audit log requires an admin role.',
          });
        }

        // Imposed, not accepted. `requireTenant` reads the tenant the session
        // resolved to, so `input.tenantId` is discarded rather than validated
        // — there is no value a tenant admin could send that would widen this.
        const tenant = requireTenant();
        return d.audit.list({
          tenantId: tenant.tenantId,
          eventClass: input.eventClass,
          before: input.before,
          limit: input.limit,
        });
      }),
  });
}
