import { Injectable, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { initTRPC } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ReportsService } from '../reports/reports.service';
import { SchemaRegistryService } from '../reports/schema-registry.service';
import { SensorsService } from '../sensors/sensors.service';
import { VmsService } from '../sensors/vms.service';
import { VoyageService } from '../sensors/voyage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { TRPCError } from '@trpc/server';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

export interface Context {
  req: any;
  res: any;
}

const t = initTRPC.context<Context>().create();
export const publicProcedure = t.procedure;
export const router = t.router;

const CreateReportSchema = Type.Object({
  schemaName: Type.String(),
  eventType: Type.String(),
  eventTime: Type.String(),
  fields: Type.Record(Type.String(), Type.Any()),
});
const CreateReportCompiler = TypeCompiler.Compile(CreateReportSchema);

const ListReportsSchema = Type.Object({
  schemaName: Type.String(),
});
const ListReportsCompiler = TypeCompiler.Compile(ListReportsSchema);

const GetReportSchema = Type.Object({
  id: Type.String(),
});
const GetReportCompiler = TypeCompiler.Compile(GetReportSchema);

const SaveSectionSchema = Type.Object({
  id: Type.String(),
  section: Type.String(),
  changes: Type.Record(Type.String(), Type.Any()),
});
const SaveSectionCompiler = TypeCompiler.Compile(SaveSectionSchema);

const LockSectionSchema = Type.Object({
  id: Type.String(),
  section: Type.String(),
});
const LockSectionCompiler = TypeCompiler.Compile(LockSectionSchema);

const ListLocksSchema = Type.Object({
  id: Type.String(),
});
const ListLocksCompiler = TypeCompiler.Compile(ListLocksSchema);

const SubmitReportSchema = Type.Object({
  id: Type.String(),
});
const SubmitReportCompiler = TypeCompiler.Compile(SubmitReportSchema);

const ValidateReportSchema = Type.Object({
  id: Type.String(),
  fields: Type.Record(Type.String(), Type.Any()),
});
const ValidateReportCompiler = TypeCompiler.Compile(ValidateReportSchema);

const AcknowledgeFindingSchema = Type.Object({
  id: Type.String(),
  ruleId: Type.String(),
  field: Type.Optional(Type.String()),
  message: Type.String(),
  acknowledged: Type.Boolean(),
});
const AcknowledgeFindingCompiler = TypeCompiler.Compile(AcknowledgeFindingSchema);

const ListInvalidationNoticesSchema = Type.Object({
  reportId: Type.String(),
});
const ListInvalidationNoticesCompiler = TypeCompiler.Compile(ListInvalidationNoticesSchema);

const ListEventsSchema = Type.Object({
  reportId: Type.String(),
});
const ListEventsCompiler = TypeCompiler.Compile(ListEventsSchema);

const GetChatSchema = Type.Object({
  reportId: Type.String(),
});
const GetChatCompiler = TypeCompiler.Compile(GetChatSchema);

const SendChatMessageSchema = Type.Object({
  reportId: Type.String(),
  body: Type.String(),
});
const SendChatMessageCompiler = TypeCompiler.Compile(SendChatMessageSchema);

const GetSchemaInputSchema = Type.Object({
  schemaName: Type.String(),
});
const GetSchemaCompiler = TypeCompiler.Compile(GetSchemaInputSchema);

const GetEnumInputSchema = Type.Object({
  name: Type.String(),
});
const GetEnumCompiler = TypeCompiler.Compile(GetEnumInputSchema);

const UpdateSettingsSchema = Type.Record(Type.String(), Type.String());
const UpdateSettingsCompiler = TypeCompiler.Compile(UpdateSettingsSchema);

const SaveSensorSourceSchema = Type.Object({
  baseUrl: Type.String(),
  apiKey: Type.String(),
  enabled: Type.Boolean(),
});
const SaveSensorSourceCompiler = TypeCompiler.Compile(SaveSensorSourceSchema);

const TestSensorSourceSchema = Type.Object({
  baseUrl: Type.String(),
  apiKey: Type.String(),
});
const TestSensorSourceCompiler = TypeCompiler.Compile(TestSensorSourceSchema);

const SaveVmsSourceSchema = Type.Object({
  baseUrl: Type.String(),
  apiKey: Type.String(),
  enabled: Type.Boolean(),
});
const SaveVmsSourceCompiler = TypeCompiler.Compile(SaveVmsSourceSchema);

const TestVmsSourceSchema = Type.Object({
  baseUrl: Type.String(),
  apiKey: Type.String(),
});
const TestVmsSourceCompiler = TypeCompiler.Compile(TestVmsSourceSchema);

const FetchVmsDataSchema = Type.Object({
  schemaName: Type.String(),
  eventTime: Type.String(),
});
const FetchVmsDataCompiler = TypeCompiler.Compile(FetchVmsDataSchema);

const CreateUserSchema = Type.Object({
  username: Type.String(),
  role: Type.String(),
  canSubmit: Type.Boolean(),
});
const CreateUserCompiler = TypeCompiler.Compile(CreateUserSchema);

const UpdateUserStatusSchema = Type.Object({
  id: Type.String(),
  active: Type.Boolean(),
});
const UpdateUserStatusCompiler = TypeCompiler.Compile(UpdateUserStatusSchema);

const UpdateUserRoleSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
});
const UpdateUserRoleCompiler = TypeCompiler.Compile(UpdateUserRoleSchema);

const AdminResetPasswordSchema = Type.Object({
  id: Type.String(),
});
const AdminResetPasswordCompiler = TypeCompiler.Compile(AdminResetPasswordSchema);

import { SyncService } from '../sync/sync.service';
import { AuthService } from '../auth/auth.service';

const SyncStatusSchema = Type.Object({
  enrolled: Type.Boolean(),
  lastSuccess: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
});
const SyncStatusCompiler = TypeCompiler.Compile(SyncStatusSchema);

import { TrpcService } from './trpc.service';

// Every column of `users` except passwordHash. `select()` with no
// argument returns the whole row, so both users.me and users.list used to
// hand the caller each account's argon2 hash — offline brute-force
// material handed to anyone who could reach the endpoint, and to anything
// that later cached or logged the response. Listing the columns
// explicitly means a column added later has to be opted in rather than
// leaking by default.
const PUBLIC_USER_COLUMNS = {
  id: schema.users.id,
  username: schema.users.username,
  role: schema.users.role,
  canSubmit: schema.users.canSubmit,
  mustChangePassword: schema.users.mustChangePassword,
  active: schema.users.active,
  createdAt: schema.users.createdAt,
  updatedAt: schema.users.updatedAt,
};

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly trpcService: TrpcService,
    private readonly reportsService: ReportsService,
    private readonly schemaRegistryService: SchemaRegistryService,
    private readonly sensorsService: SensorsService,
    private readonly vmsService: VmsService,
    private readonly voyageService: VoyageService,
    private readonly syncService: SyncService,
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
    // Verification goes through the same JwtService that signs, so both
    // sides use this vessel's own secret (see auth/jwt-secret.ts). They
    // used to read process.env.JWT_SECRET independently and fall back to
    // a constant shared by every vessel.
    private readonly jwtService: JwtService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  // Re-checks the account's live `active` flag (and picks up its current
  // role/canSubmit) on every request, rather than trusting whatever was
  // true at login time — mirrors ovl/vessel/httpapi/server.go's
  // authenticatedUser ("so a Master deactivating a user kills that
  // user's live session immediately, not just their next login
  // attempt") and the same fix already applied to login itself in
  // AuthService.validateUser. Needs this.db, so this has to be an
  // instance field (built after the constructor assigns it) rather than
  // the module-level middleware this replaced.
  private readonly isAuthed = t.middleware(async ({ ctx, next }) => {
    const token = ctx.req?.cookies?.['vessel_auth_token'];
    if (!token) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not logged in' });
    }

    let decoded: any;
    try {
      decoded = this.jwtService.verify(token);
    } catch {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid token' });
    }

    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, decoded.sub)).limit(1);
    const user = rows[0];
    // Distinguish "this token is for an account this vessel has never
    // heard of" from "the account exists and has been deactivated".
    // Reporting both as "Account is inactive" sent people hunting for a
    // disabled account that was in fact perfectly active.
    //
    // Vessels now sign with their own secret (auth/jwt-secret.ts), so a
    // token from another vessel fails signature checking and never gets
    // this far. This branch still matters: a token outlives the account
    // it names (deleted user, restored-from-backup database, a vessel
    // re-provisioned onto the same host), and saying which of the two
    // happened is the difference between a five-minute fix and a hunt
    // through a user list where every account is active.
    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session belongs to a different vessel' });
    }
    if (!user.active) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Account is inactive' });
    }

    return next({
      ctx: {
        ...ctx,
        user: { ...decoded, role: user.role, canSubmit: user.canSubmit, active: user.active },
      },
    });
  });
  private readonly protectedProcedure = t.procedure.use(this.isAuthed);

  appRouter = router({
    ping: publicProcedure.query(() => {
      return {
        message: `Pong received from Vessel API`,
        timestamp: new Date().toISOString(),
      };
    }),
    reports: router({
      listReports: this.protectedProcedure
        .input((val: unknown) => {
          if (!ListReportsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListReportsSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.listReports(input.schemaName);
        }),
      createReport: this.protectedProcedure
        .input((val: unknown) => {
          if (!CreateReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.createReport(input, ctx.user.username);
        }),
      getReport: this.protectedProcedure
        .input((val: unknown) => {
          if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetReportSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.getReport(input.id);
        }),
      /**
       * Everything the report form needs to first paint, in one round trip.
       *
       * The form used to fetch these separately, and each depended on the
       * one before it: getSchema and getFieldPolicy need report.schemaName,
       * and the getEnum calls need schema.fields to know which enumRefs to
       * resolve. That is a three-deep waterfall — cheap on a LAN, but each
       * wave costs a full round trip, so against a distant office it was
       * measured at roughly 580ms per wave and about two seconds before the
       * form was usable. Resolving the chain server-side collapses it to one.
       *
       * The individual procedures stay: other callers still use them, and
       * they are the natural granularity for refetching one piece.
       */
      getFormBundle: this.protectedProcedure
        .input((val: unknown) => {
          if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetReportSchema>;
        })
        .query(async ({ input }) => {
          const report = await this.reportsService.getReport(input.id);
          if (!report) {
            // Same shape as the success path so the client sees one type.
            return {
              report: null,
              schema: null,
              fieldPolicy: null,
              enums: {} as Record<string, string[]>,
            };
          }

          const formSchema = this.schemaRegistryService.getSchema(report.schemaName);

          // Same lookup reports.getFieldPolicy performs — kept in step with
          // it deliberately, including the ".json" stripping.
          let fieldPolicy: { policy: Record<string, string>; prefill: Record<string, string>; events: Record<string, string[]> } =
            { policy: {}, prefill: {}, events: {} };
          const bundleRows = await this.db
            .select()
            .from(schema.configStore)
            .where(eq(schema.configStore.key, 'config_bundle'));
          if (bundleRows.length > 0) {
            try {
              const bundle = JSON.parse(bundleRows[0].value);
              const bare = report.schemaName.replace(/\.json$/, '');
              const match = (bundle.schemas || []).find((x: any) => x.schemaName === bare);
              if (match) {
                fieldPolicy = {
                  policy: match.policy || {},
                  prefill: match.prefill || {},
                  events: match.events || {},
                };
              }
            } catch {
              // A corrupt stored bundle must not stop the form loading; the
              // field policy simply comes back empty, exactly as before.
            }
          }

          // Only the refs this schema actually references, resolved here so
          // the client does not need a second wave to discover them.
          const enums: Record<string, string[]> = {};
          for (const ref of new Set(
            (formSchema.fields || [])
              .filter((f: any) => f.type === 'enum' && f.enumRef)
              .map((f: any) => f.enumRef as string),
          )) {
            enums[ref] = this.schemaRegistryService.resolveEnum(ref) ?? [];
          }

          return { report, schema: formSchema, fieldPolicy, enums };
        }),
      saveSection: this.protectedProcedure
        .input((val: unknown) => {
          if (!SaveSectionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveSectionSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.saveSection(
            input.id,
            { section: input.section, changes: input.changes },
            ctx.user.username,
            ctx.user.sub,
          );
        }),
      // Section soft-locking (architecture 9.5). No SSE/live-push
      // transport in this port (none exists anywhere else in this app
      // either) — the frontend polls listLocks periodically instead;
      // saveSection's own server-side check above is the real backstop
      // regardless of how fresh the client's last poll was.
      listLocks: this.protectedProcedure
        .input((val: unknown) => {
          if (!ListLocksCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListLocksSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.listLocks(input.id);
        }),
      acquireLock: this.protectedProcedure
        .input((val: unknown) => {
          if (!LockSectionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof LockSectionSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.acquireLock(input.id, input.section, ctx.user.sub, ctx.user.username, ctx.user.role);
        }),
      releaseLock: this.protectedProcedure
        .input((val: unknown) => {
          if (!LockSectionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof LockSectionSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.releaseLock(input.id, input.section, ctx.user.sub);
        }),
      forceReleaseLock: this.protectedProcedure
        .input((val: unknown) => {
          if (!LockSectionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof LockSectionSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          // Architecture 9.3/9.5: Master-only force-release.
          if (ctx.user.role?.toLowerCase() !== 'master') {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the Master account may force-release a section lock.' });
          }
          return this.reportsService.forceReleaseLock(input.id, input.section);
        }),
      submitReport: this.protectedProcedure
        .input((val: unknown) => {
          if (!SubmitReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SubmitReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          // Mirrors ovl/vessel/auth/user.go's CanSubmitReports (architecture
          // 9.3): Master always may; everyone else needs the canSubmit flag.
          // Previously any authenticated user could submit regardless of
          // this flag, which made the Users screen's "Can Submit" toggle a
          // no-op.
          const canSubmit = ctx.user.role?.toLowerCase() === 'master' || ctx.user.canSubmit === true;
          if (!canSubmit) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to submit reports.' });
          }
          return this.reportsService.submitReport(input.id, ctx.user.username);
        }),
      check: this.protectedProcedure
        .input((val: unknown) => {
          if (!SubmitReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SubmitReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.checkReport(input.id, ctx.user.username);
        }),
      validate: this.protectedProcedure
        .input((val: unknown) => {
          if (!ValidateReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ValidateReportSchema>;
        })
        .mutation(async ({ input }) => {
          return this.reportsService.validateReport(input.id, input.fields);
        }),
      acknowledgeFinding: this.protectedProcedure
        .input((val: unknown) => {
          if (!AcknowledgeFindingCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AcknowledgeFindingSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          const { id, ...detail } = input;
          return this.reportsService.acknowledgeFinding(id, detail, ctx.user.username);
        }),
      listInvalidationNotices: this.protectedProcedure
        .input((val: unknown) => {
          if (!ListInvalidationNoticesCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListInvalidationNoticesSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.listInvalidationNotices(input.reportId);
        }),
      startCorrection: this.protectedProcedure
        .input((val: unknown) => {
          if (!SubmitReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SubmitReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.startCorrection(input.id, ctx.user.username);
        }),
      listEvents: publicProcedure
        .input((val: unknown) => {
          if (!ListEventsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListEventsSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.listEvents(input.reportId);
        }),
      getChat: publicProcedure
        .input((val: unknown) => {
          if (!GetChatCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetChatSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.getChat(input.reportId);
        }),
      sendChatMessage: publicProcedure
        .input((val: unknown) => {
          if (!SendChatMessageCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SendChatMessageSchema>;
        })
        .mutation(async ({ input }) => {
          const username = 'vessel-admin';
          return this.reportsService.sendChatMessage(input.reportId, input.body, username);
        }),
      getRemarks: publicProcedure
        .input((val: unknown) => {
          if (!GetChatCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetChatSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.getRemarks(input.reportId);
        }),
      getSchema: publicProcedure
        .input((val: unknown) => {
          if (!GetSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetSchemaInputSchema>;
        })
        .query(async ({ input }) => {
          return this.schemaRegistryService.getSchema(input.schemaName);
        }),
      listEventSuggestions: publicProcedure
        .input((val: unknown) => {
          if (!GetSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetSchemaInputSchema>;
        })
        .query(async () => {
          // Hardcoded suggestions based on standard voyage events
          return ['NOON', 'ARRIVAL', 'DEPARTURE', 'BUNKER_OPERATION'];
        }),
      // Resolves a curated field's enumRef (e.g. "fuel-types") to its
      // valid codes. Returns an empty array for an enumRef with no
      // generic resolver — the form falls back to unrestricted text
      // entry for those, matching the original's behavior.
      getEnum: publicProcedure
        .input((val: unknown) => {
          if (!GetEnumCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetEnumInputSchema>;
        })
        .query(async ({ input }) => {
          return this.schemaRegistryService.resolveEnum(input.name) ?? [];
        }),
      // Any authenticated user (matches opening the report form itself) —
      // not admin/master-gated like vms.get/save/test, since this is a
      // read-only external query triggered from the form, not a
      // configuration change.
      fetchVmsData: this.protectedProcedure
        .input((val: unknown) => {
          if (!FetchVmsDataCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof FetchVmsDataSchema>;
        })
        .mutation(async ({ input }) => {
          const fields = await this.vmsService.fetchFieldsForReport(input.schemaName, new Date(input.eventTime));
          return { fields };
        }),
      // Field-level policy (hidden/optional/recommended/mandatory,
      // prefill class, per-event narrowing) for one schema, read from the
      // config bundle office already syncs down (SyncService.pullConfiguration
      // -> configStore key "config_bundle") — no new sync plumbing needed,
      // this just exposes what's already on the vessel. Mirrors office's
      // fieldPolicies.get shape (policy/prefill/events maps keyed by field
      // name) so the frontend's effectiveState/appliesToEvent logic, ported
      // from apps/web-office/src/lib/config/fieldPolicyLogic.ts, works
      // identically on both sides.
      getFieldPolicy: publicProcedure
        .input((val: unknown) => {
          if (!GetSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetSchemaInputSchema>;
        })
        .query(async ({ input }) => {
          const empty = { policy: {}, prefill: {}, events: {} };
          const rows = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'config_bundle'));
          if (rows.length === 0) return empty;
          try {
            const bundle = JSON.parse(rows[0].value);
            // Reports store schemaName with a ".json" suffix (see
            // reports.getReport's response) but the config bundle's own
            // schema entries — and schemaRegistryService.getSchema's own
            // normalization — use the bare name. Strip it the same way so
            // this lookup doesn't silently miss.
            const bareSchemaName = input.schemaName.replace(/\.json$/, '');
            const match = (bundle.schemas || []).find((s: any) => s.schemaName === bareSchemaName);
            if (!match) return empty;
            return {
              policy: match.policy || {},
              prefill: match.prefill || {},
              events: match.events || {},
            };
          } catch {
            return empty;
          }
        }),
    }),
    sync: router({
      status: publicProcedure.query(async () => {
        return this.syncService.getStatus();
      }),
      now: publicProcedure.mutation(async () => {
        return this.syncService.syncNow();
      }),
      // Cycle-by-cycle history, so a run that failed leaves evidence the
      // next run cannot overwrite. Same shape office serves for a vessel.
      history: publicProcedure
        .input((val: unknown) => {
          const v = (val ?? {}) as { limit?: number };
          return { limit: typeof v.limit === 'number' ? v.limit : 50 };
        })
        .query(async ({ input }) => {
          return this.syncService.getHistory(input.limit);
        })
    }),
    users: router({
      me: this.protectedProcedure.query(async ({ ctx }) => {
        const usersList = await this.db.select(PUBLIC_USER_COLUMNS).from(schema.users).where(eq(schema.users.id, ctx.user.sub));
        return usersList[0] || null;
      }),
      list: this.protectedProcedure.query(async () => {
        const usersList = await this.db.select(PUBLIC_USER_COLUMNS).from(schema.users);
        return usersList;
      }),
      changePassword: this.protectedProcedure
        .input((val: unknown) => {
          const v = val as any;
          if (!v || typeof v.newPassword !== 'string') throw new Error('Invalid input');
          return v as { newPassword: string };
        })
        .mutation(async ({ input, ctx }) => {
          const argon2 = await import('argon2');
          const passwordHash = await argon2.hash(input.newPassword);
          await this.db.update(schema.users)
            .set({ 
              passwordHash,
              mustChangePassword: false,
              updatedAt: new Date().toISOString()
            })
            .where(eq(schema.users.id, ctx.user.sub));
          return { success: true };
        }),
      create: publicProcedure
        .input((val: unknown) => {
          if (!CreateUserCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateUserSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          // Anonymous creation is only allowed to bootstrap the very first
          // (master admin) user during initial setup. Once any user exists,
          // this requires a valid session — otherwise anyone could mint
          // arbitrary admin accounts at any time.
          const existingUsers = await this.db.select().from(schema.users).limit(1);
          if (existingUsers.length > 0) {
            const token = ctx.req?.cookies?.['vessel_auth_token'];
            let authed = false;
            if (token) {
              try {
                this.jwtService.verify(token);
                authed = true;
              } catch {
                authed = false;
              }
            }
            if (!authed) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Log in to create additional users.' });
            }
          }

          // Username-taken and role=master checks, temporary-password
          // generation, and the insert itself now live in
          // AuthService.createLocalUser — the shared core this mutation
          // and applyUserCommand (office-queued remote commands, applied
          // in SyncService) both call, so the two entry points can't drift
          // on what's allowed the way two separate copies eventually would.
          const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
          const bytes = crypto.randomBytes(12);
          const temporaryPassword = Array.from(bytes).map((b: number) => chars[b % chars.length]).join('');
          const id = await this.authService.createLocalUser(input.username, input.role, temporaryPassword, input.canSubmit);

          return { id, temporaryPassword };
        }),
      updateStatus: this.protectedProcedure
        .input((val: unknown) => {
          if (!UpdateUserStatusCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateUserStatusSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          await this.db.update(schema.users)
            .set({ active: input.active, updatedAt: new Date().toISOString() })
            .where(eq(schema.users.id, input.id));
          return { success: true };
        }),
      updateRole: this.protectedProcedure
        .input((val: unknown) => {
          if (!UpdateUserRoleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateUserRoleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          await this.db.update(schema.users)
            .set({ role: input.role, updatedAt: new Date().toISOString() })
            .where(eq(schema.users.id, input.id));
          return { success: true };
        }),
      adminResetPassword: this.protectedProcedure
        .input((val: unknown) => {
          if (!AdminResetPasswordCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AdminResetPasswordSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          const argon2 = await import('argon2');
          const crypto = await import('crypto');
          
          const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
          const bytes = crypto.randomBytes(12);
          const temporaryPassword = Array.from(bytes).map((b: number) => chars[b % chars.length]).join('');
          
          const passwordHash = await argon2.hash(temporaryPassword);
          await this.db.update(schema.users)
            .set({ 
              passwordHash,
              mustChangePassword: true,
              updatedAt: new Date().toISOString()
            })
            .where(eq(schema.users.id, input.id));
          
          return { temporaryPassword };
        }),
    }),
    setup: router({
      status: publicProcedure.query(async () => {
        const configs = await this.db.select().from(schema.configStore);
        const configMap = configs.reduce((acc, c) => ({ ...acc, [c.key]: c.value }), {} as Record<string, string>);

        const isConfigured = !!configMap['vessel_id'];
        // Public (no auth) — lets the login page point a first-time
        // visitor at /setup instead of a login form for an account that
        // doesn't exist yet. No sensitive data, just an existence check.
        const existingUsers = await this.db.select().from(schema.users).limit(1);
        return {
          isConfigured,
          hasUsers: existingUsers.length > 0,
          vesselId: configMap['vessel_id'] || null,
          vesselName: configMap['vessel_name'] || '',
          imoNumber: configMap['imo_number'] || configMap['imoNumber'] || '', // Fallback in case of old key
          shoreUrl: configMap['shore_url'] || 'https://api.ovl.com',
          apiKey: configMap['api_key'] || ''
        };
      }),
      enroll: publicProcedure
        .input((val: unknown) => {
          const v = val as { vesselName: string; imoNumber: string; shoreUrl: string; apiKey: string };
          if (!v.vesselName || !v.imoNumber || !v.shoreUrl || !v.apiKey) throw new Error('Invalid input');
          return v;
        })
        .mutation(async ({ input }) => {
          // 1. Save preliminary identity (including API Key)
          const configs = [
            { key: 'vessel_name', value: input.vesselName },
            { key: 'imo_number', value: input.imoNumber },
            { key: 'shore_url', value: input.shoreUrl },
            { key: 'api_key', value: input.apiKey }
          ];
          
          for (const c of configs) {
            await this.db.insert(schema.configStore)
              .values({ key: c.key, value: c.value, updatedAt: new Date().toISOString() })
              .onConflictDoUpdate({ target: schema.configStore.key, set: { value: c.value, updatedAt: new Date().toISOString() } });
          }

          // 2. Call Office API to enroll and get true UUID
          // At this point, the TrpcService client will use the 'api_key' we just saved above!
          try {
            const response = await this.trpcService.client.edge.enroll.mutate({
              vesselName: input.vesselName,
              imoNumber: input.imoNumber
            });

            // Save the true UUID to configStore
            await this.db.insert(schema.configStore)
              .values({ key: 'vessel_id', value: response.vesselId, updatedAt: new Date().toISOString() })
              .onConflictDoUpdate({ target: schema.configStore.key, set: { value: response.vesselId, updatedAt: new Date().toISOString() } });
              
            return { success: true };
          } catch (e: any) {
            // Revert on failure
            await this.db.delete(schema.configStore).where(eq(schema.configStore.key, 'api_key'));
            throw new TRPCError({ code: 'BAD_REQUEST', message: `Failed to authenticate with Office API: ${e.message}` });
          }
        }),
      // Wizard step 3, mirroring the original's handleSetupMaster
      // (ovl/vessel/httpapi/setup.go) — a dedicated bootstrap path for the
      // very first user, distinct from users.create/AuthService.createLocalUser
      // (which deliberately reject role=master, since every user after the
      // first must go through an authenticated admin). Unlike createLocalUser,
      // the master chooses their own password here and is logged in
      // immediately, rather than getting a generated temporary one.
      createMaster: publicProcedure
        .input((val: unknown) => {
          const v = val as { username: string; password: string };
          if (!v.username || !v.password) throw new Error('Invalid input');
          return v;
        })
        .mutation(async ({ input, ctx }) => {
          const existingUsers = await this.db.select().from(schema.users).limit(1);
          if (existingUsers.length > 0) {
            throw new TRPCError({ code: 'CONFLICT', message: 'A user already exists; use the login screen instead.' });
          }

          const argon2 = await import('argon2');
          const passwordHash = await argon2.hash(input.password);
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          await this.db.insert(schema.users).values({
            id,
            username: input.username,
            passwordHash,
            role: 'master',
            canSubmit: true,
            mustChangePassword: false,
            active: true,
            createdAt: now,
            updatedAt: now,
          });

          const { access_token } = await this.authService.login({
            id,
            username: input.username,
            role: 'master',
            mustChangePassword: false,
          });
          // Secure defaults off — see auth.controller.ts's login cookie
          // for why (a Secure cookie is silently dropped over plain
          // HTTP, which is this app's common deployment).
          ctx.res.cookie('vessel_auth_token', access_token, {
            httpOnly: true,
            secure: process.env.COOKIE_SECURE === 'true',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
          });

          return { success: true };
        }),
    }),
    system: router({
      getTelemetry: publicProcedure.query(async () => {
        return this.sensorsService.getTelemetry();
      }),
      getActiveVoyage: publicProcedure.query(async () => {
        return this.voyageService.getActiveVoyage();
      }),
    }),
    sensors: router({
      // Master/Admin-only, mirroring the original's requireSuperAdmin
      // gate on the equivalent config endpoints.
      get: this.protectedProcedure.query(async ({ ctx }) => {
        if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
        return this.sensorsService.getSource();
      }),
      save: this.protectedProcedure
        .input((val: unknown) => {
          if (!SaveSensorSourceCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveSensorSourceSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          if (!input.baseUrl || !input.apiKey) throw new TRPCError({ code: 'BAD_REQUEST', message: 'baseUrl and apiKey are required' });
          return this.sensorsService.saveSource(input.baseUrl, input.apiKey, input.enabled);
        }),
      test: this.protectedProcedure
        .input((val: unknown) => {
          if (!TestSensorSourceCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof TestSensorSourceSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          return this.sensorsService.testSource(input.baseUrl, input.apiKey);
        }),
    }),
    vms: router({
      // Master/Admin-only, mirroring the original's requireSuperAdmin
      // gate on the equivalent config endpoints.
      get: this.protectedProcedure.query(async ({ ctx }) => {
        if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
        return this.vmsService.getSource();
      }),
      save: this.protectedProcedure
        .input((val: unknown) => {
          if (!SaveVmsSourceCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveVmsSourceSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          if (!input.baseUrl || !input.apiKey) throw new TRPCError({ code: 'BAD_REQUEST', message: 'baseUrl and apiKey are required' });
          return this.vmsService.saveSource(input.baseUrl, input.apiKey, input.enabled);
        }),
      test: this.protectedProcedure
        .input((val: unknown) => {
          if (!TestVmsSourceCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof TestVmsSourceSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.toLowerCase().includes('admin') && !ctx.user.role.toLowerCase().includes('master')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Unauthorized' });
          return this.vmsService.testSource(input.baseUrl, input.apiKey);
        }),
    }),
    notifications: router({
      list: publicProcedure.query(async () => {
        return this.notificationsService.list();
      }),
    }),
    settings: router({
      get: publicProcedure.query(async () => {
        // Return all config key-values
        const result = await this.db.select().from(schema.configStore);
        const settings: Record<string, string> = {};
        result.forEach(row => {
          settings[row.key] = row.value;
        });
        return settings;
      }),
      update: publicProcedure
        .input((val: unknown) => {
          if (!UpdateSettingsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateSettingsSchema>;
        })
        .mutation(async ({ input }) => {
          for (const [key, value] of Object.entries(input)) {
            await this.db
              .insert(schema.configStore)
              .values({
                key,
                value,
                updatedAt: new Date().toISOString(),
              })
              .onConflictDoUpdate({
                target: schema.configStore.key,
                set: {
                  value,
                  updatedAt: new Date().toISOString(),
                },
              });
          }
          return { success: true };
        }),
    }),
  });
}

export type AppRouter = TrpcRouter['appRouter'];
