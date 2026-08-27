import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { protectedProcedure, router } from './trpc.base';
import { SupertokensService } from '../auth/supertokens.service';
import { NotificationsService } from '../notifications/notifications.service';

const MarkNotificationsReadSchema = Type.Object({
  ids: Type.Array(Type.String()),
});
const MarkNotificationsReadCompiler = TypeCompiler.Compile(MarkNotificationsReadSchema);

/**
 * The notifications domain, lifted out of the monolithic router.
 *
 * First of the per-domain splits. The router file had grown past 2,400 lines
 * with nested sub-routers, which is why every attempt to migrate it onto
 * per-tenant schemas — by hand or by script — kept failing: there was no way to
 * change one domain without a diff nobody could review. Each domain gets its
 * own file so the tenancy migration lands as a series of small, readable
 * changes instead of one sweep.
 *
 * The procedures themselves are unchanged. This is a move, not a rewrite; the
 * sync contract suite and the live vessel are what prove that.
 *
 * Takes a *getter* for its dependencies rather than the services themselves.
 * TrpcRouter composes this inside a class field initializer, and those run
 * before TypeScript assigns constructor parameter properties — so anything
 * dereferenced eagerly there would be undefined. The getter defers the lookup
 * to when a resolver actually runs, which is when the existing procedures
 * already read `this.someService`.
 */
export interface NotificationsRouterDeps {
  supertokensService: SupertokensService;
  notificationsService: NotificationsService;
}

export const createNotificationsRouter = (deps: () => NotificationsRouterDeps) =>
  router({
    // A read-only projection over overdue vessels, recent vessel chat
    // replies, and recent report-landing activity — see NotificationsService's
    // own doc comment for why there's no notifications table backing this.
    // Each user's read-state is private to them (notification_read_state is
    // keyed by user id).
    list: protectedProcedure.query(async ({ ctx }) => {
      // A 401 here (rather than the same graceful-fallback pattern every other
      // localUser lookup uses) gets treated by the frontend's SuperTokens
      // interceptor as "session needs refreshing" globally — not as this
      // endpoint's own concern — which retries the request 10 times against an
      // unrelated failure and then gives up loudly. No local user just means no
      // read-state can be tracked for this session; degrade to showing every
      // notification unread rather than erroring.
      const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
      return deps().notificationsService.list(localUser?.id ?? null);
    }),

    markRead: protectedProcedure
      .input((val: unknown) => {
        if (!MarkNotificationsReadCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof MarkNotificationsReadSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
        if (!localUser) return { marked: 0 };
        const marked = await deps().notificationsService.markRead(localUser.id, input.ids);
        return { marked };
      }),
  });
