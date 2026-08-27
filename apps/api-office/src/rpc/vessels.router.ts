import { TRPCError } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { protectedProcedure, router } from './trpc.base';
import { SupertokensService } from '../auth/supertokens.service';
import { VesselsService } from '../vessels/vessels.service';
import { VesselUsersService } from '../vessels/vessel-users.service';
import { formatRelativeTime, ONLINE_THRESHOLD_MS } from './display';

/**
 * Fleet management: the vessel roster, its groups, and the per-vessel user
 * commands the office queues for a ship to apply on its next check-in.
 *
 * Reads and writes the same tables the sync path does, which is why it is being
 * lifted out alongside it — when `vessels` and `report_versions` move to
 * per-tenant schemas, every reader has to move in the same change or the office
 * UI stops seeing what vessels push.
 *
 * Dependencies arrive as a getter; see notifications.router.ts for why.
 */
export interface VesselsRouterDeps {
  db: NodePgDatabase<typeof schema>;
  supertokensService: SupertokensService;
  vesselsService: VesselsService;
  vesselUsersService: VesselUsersService;
}

const CreateVesselSchema = Type.Object({
  name: Type.String(),
  imo: Type.String(),
  type: Type.String(),
  groups: Type.Optional(Type.Array(Type.String())),
});
const CreateVesselCompiler = TypeCompiler.Compile(CreateVesselSchema);

const DeleteVesselSchema = Type.Object({
  id: Type.String(),
});
const DeleteVesselCompiler = TypeCompiler.Compile(DeleteVesselSchema);

const DeleteVesselGroupSchema = Type.Object({
  group: Type.String(),
});
const DeleteVesselGroupCompiler = TypeCompiler.Compile(DeleteVesselGroupSchema);

const ListVesselPositionsSchema = Type.Object({
  group: Type.Optional(Type.String()),
});
const ListVesselPositionsCompiler = TypeCompiler.Compile(ListVesselPositionsSchema);

const QueueCreateUserSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  role: Type.String(),
});
const QueueCreateUserCompiler = TypeCompiler.Compile(QueueCreateUserSchema);

const QueueSetActiveSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  active: Type.Boolean(),
});
const QueueSetActiveCompiler = TypeCompiler.Compile(QueueSetActiveSchema);

const QueueSetCanSubmitSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  canSubmit: Type.Boolean(),
});
const QueueSetCanSubmitCompiler = TypeCompiler.Compile(QueueSetCanSubmitSchema);

const QueueSetRoleSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
  role: Type.String(),
});
const QueueSetRoleCompiler = TypeCompiler.Compile(QueueSetRoleSchema);

const QueueUsernameActionSchema = Type.Object({
  vesselId: Type.String(),
  username: Type.String(),
});
const QueueUsernameActionCompiler = TypeCompiler.Compile(QueueUsernameActionSchema);

const RenameVesselGroupSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
});
const RenameVesselGroupCompiler = TypeCompiler.Compile(RenameVesselGroupSchema);

const UpdateVesselSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  imo: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  groups: Type.Optional(Type.Array(Type.String())),
});
const UpdateVesselCompiler = TypeCompiler.Compile(UpdateVesselSchema);

const VesselIdInputSchema = Type.Object({
  vesselId: Type.String(),
});
const VesselIdInputCompiler = TypeCompiler.Compile(VesselIdInputSchema);

export const createVesselsRouter = (deps: () => VesselsRouterDeps) =>
  router({
    list: protectedProcedure.query(async () => {
      const rows = await deps().db.select({
        vessel: schema.vessels,
        lastSeenAt: schema.vesselSyncStatus.lastSeenAt,
      })
        .from(schema.vessels)
        .leftJoin(schema.vesselSyncStatus, eq(schema.vesselSyncStatus.vesselId, schema.vessels.id));

      const now = Date.now();

      return rows.map(({ vessel: v, lastSeenAt }) => {
        const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : null;
        return {
          id: v.id,
          name: v.name,
          imo: v.imo,
          type: v.type,
          status: 'At Sea',
          edgeStatus: lastSeenMs === null ? 'Offline' : (now - lastSeenMs <= ONLINE_THRESHOLD_MS ? 'Online' : 'Offline'),
          lastSync: lastSeenAt ? formatRelativeTime(lastSeenMs!) : 'Never',
          groups: v.groups,
        };
      });
    }),
    // Fleet Map (ports ovl/office/httpapi/vesselpositions.go). See
    // VesselsService.getPositions's own doc comment for the full
    // status-precedence and position-parsing rules.
    positions: protectedProcedure
      .input((val: unknown) => {
        if (!ListVesselPositionsCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof ListVesselPositionsSchema>;
      })
      .query(({ input }) => deps().vesselsService.getPositions(input.group)),
    create: protectedProcedure
      .input((val: unknown) => {
        if (!CreateVesselCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof CreateVesselSchema>;
      })
      .mutation(async ({ input }) => {
        const newVessel = await deps().db.insert(schema.vessels).values({
          name: input.name,
          imo: input.imo,
          type: input.type,
          groups: input.groups || [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).returning();
        return newVessel[0];
      }),
    update: protectedProcedure
      .input((val: unknown) => {
        if (!UpdateVesselCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof UpdateVesselSchema>;
      })
      .mutation(async ({ input }) => {
        const { id, ...updates } = input;
        const updatedVessel = await deps().db.update(schema.vessels).set({
          ...updates,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.vessels.id, id)).returning();
        return updatedVessel[0];
      }),
    delete: protectedProcedure
      .input((val: unknown) => {
        if (!DeleteVesselCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof DeleteVesselSchema>;
      })
      .mutation(async ({ input }) => {
        await deps().db.delete(schema.vessels).where(eq(schema.vessels.id, input.id));
        return { success: true };
      }),
    // Groups are free-form JSONB tags on vessels.groups (architecture
    // 12.4), not a first-class entity — no dedicated groups table, by
    // design (ports ovl/office/httpapi/vesselgroups.go exactly,
    // including its own reasoning for why one hasn't been introduced).
    // The group catalog itself is just the union of every vessel's own
    // groups array (vessels.list already returns it) — rename/delete
    // below mutate that array directly, one vessel row at a time.
    renameGroup: protectedProcedure
      .input((val: unknown) => {
        if (!RenameVesselGroupCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof RenameVesselGroupSchema>;
      })
      .mutation(async ({ input }) => {
        if (!input.from || !input.to) throw new TRPCError({ code: 'BAD_REQUEST', message: 'from and to are both required' });
        const all = await deps().db.select({ id: schema.vessels.id, groups: schema.vessels.groups }).from(schema.vessels);
        let updated = 0;
        for (const v of all) {
          const groups = (v.groups as string[]) ?? [];
          if (!groups.includes(input.from)) continue;
          const next = groups.map((g) => (g === input.from ? input.to : g));
          await deps().db.update(schema.vessels).set({ groups: next, updatedAt: new Date().toISOString() }).where(eq(schema.vessels.id, v.id));
          updated++;
        }
        return { vesselsUpdated: updated };
      }),
    deleteGroup: protectedProcedure
      .input((val: unknown) => {
        if (!DeleteVesselGroupCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof DeleteVesselGroupSchema>;
      })
      .mutation(async ({ input }) => {
        if (!input.group) throw new TRPCError({ code: 'BAD_REQUEST', message: 'group is required' });
        const all = await deps().db.select({ id: schema.vessels.id, groups: schema.vessels.groups }).from(schema.vessels);
        let updated = 0;
        for (const v of all) {
          const groups = (v.groups as string[]) ?? [];
          if (!groups.includes(input.group)) continue;
          const next = groups.filter((g) => g !== input.group);
          await deps().db.update(schema.vessels).set({ groups: next, updatedAt: new Date().toISOString() }).where(eq(schema.vessels.id, v.id));
          updated++;
        }
        return { vesselsUpdated: updated };
      }),
    // Remote vessel-user administration (architecture 9.3/12.4) — see
    // VesselUsersService's own doc comment for the full design. Every
    // mutation here queues a command the vessel applies on its own next
    // sync cycle; nothing here writes to the vessel's local user table
    // directly, since it may be offline for hours or days.
    users: router({
      list: protectedProcedure
        .input((val: unknown) => {
          if (!VesselIdInputCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof VesselIdInputSchema>;
        })
        .query(({ input }) => deps().vesselUsersService.listRoster(input.vesselId)),
      listCommands: protectedProcedure
        .input((val: unknown) => {
          if (!VesselIdInputCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof VesselIdInputSchema>;
        })
        .query(({ input }) => deps().vesselUsersService.listCommands(input.vesselId)),
      create: protectedProcedure
        .input((val: unknown) => {
          if (!QueueCreateUserCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof QueueCreateUserSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const issuedBy = localUser?.username || 'office';
          return deps().vesselUsersService.queueCreate(input.vesselId, input.username, input.role, issuedBy);
        }),
      resetPassword: protectedProcedure
        .input((val: unknown) => {
          if (!QueueUsernameActionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof QueueUsernameActionSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const issuedBy = localUser?.username || 'office';
          return deps().vesselUsersService.queueResetPassword(input.vesselId, input.username, issuedBy);
        }),
      setRole: protectedProcedure
        .input((val: unknown) => {
          if (!QueueSetRoleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof QueueSetRoleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const issuedBy = localUser?.username || 'office';
          return deps().vesselUsersService.queueSetRole(input.vesselId, input.username, input.role, issuedBy);
        }),
      setActive: protectedProcedure
        .input((val: unknown) => {
          if (!QueueSetActiveCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof QueueSetActiveSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const issuedBy = localUser?.username || 'office';
          return deps().vesselUsersService.queueSetActive(input.vesselId, input.username, input.active, issuedBy);
        }),
      setCanSubmit: protectedProcedure
        .input((val: unknown) => {
          if (!QueueSetCanSubmitCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof QueueSetCanSubmitSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const issuedBy = localUser?.username || 'office';
          return deps().vesselUsersService.queueSetCanSubmit(input.vesselId, input.username, input.canSubmit, issuedBy);
        }),
    }),
    });
