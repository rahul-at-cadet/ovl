import { Injectable, Inject } from '@nestjs/common';
import { initTRPC } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ReportsService } from '../reports/reports.service';
import { SchemaRegistryService } from '../reports/schema-registry.service';
import { SensorsService } from '../sensors/sensors.service';
import { VmsService } from '../sensors/vms.service';
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

const isAuthed = t.middleware(({ ctx, next }) => {
  const token = ctx.req?.cookies?.['vessel_auth_token'];
  if (!token) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not logged in' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'vessel-edge-secret-key-123') as any;
    return next({
      ctx: {
        ...ctx,
        user: decoded,
      },
    });
  } catch (err) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  }
});
export const protectedProcedure = t.procedure.use(isAuthed);

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

const SubmitReportSchema = Type.Object({
  id: Type.String(),
});
const SubmitReportCompiler = TypeCompiler.Compile(SubmitReportSchema);

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

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly trpcService: TrpcService,
    private readonly reportsService: ReportsService,
    private readonly schemaRegistryService: SchemaRegistryService,
    private readonly sensorsService: SensorsService,
    private readonly vmsService: VmsService,
    private readonly syncService: SyncService,
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  appRouter = router({
    ping: publicProcedure.query(() => {
      return {
        message: `Pong received from Vessel API`,
        timestamp: new Date().toISOString(),
      };
    }),
    reports: router({
      listReports: protectedProcedure
        .input((val: unknown) => {
          if (!ListReportsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListReportsSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.listReports(input.schemaName);
        }),
      createReport: protectedProcedure
        .input((val: unknown) => {
          if (!CreateReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.createReport(input, ctx.user.username);
        }),
      getReport: protectedProcedure
        .input((val: unknown) => {
          if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetReportSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.getReport(input.id);
        }),
      saveSection: protectedProcedure
        .input((val: unknown) => {
          if (!SaveSectionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveSectionSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.saveSection(
            input.id,
            { section: input.section, changes: input.changes },
            ctx.user.username,
          );
        }),
      submitReport: protectedProcedure
        .input((val: unknown) => {
          if (!SubmitReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SubmitReportSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          return this.reportsService.submitReport(input.id, ctx.user.username);
        }),
      startCorrection: protectedProcedure
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
      })
    }),
    users: router({
      me: protectedProcedure.query(async ({ ctx }) => {
        const usersList = await this.db.select().from(schema.users).where(eq(schema.users.id, ctx.user.sub));
        return usersList[0] || null;
      }),
      list: protectedProcedure.query(async () => {
        const usersList = await this.db.select().from(schema.users);
        return usersList;
      }),
      changePassword: protectedProcedure
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
                jwt.verify(token, process.env.JWT_SECRET || 'vessel-edge-secret-key-123');
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
      updateStatus: protectedProcedure
        .input((val: unknown) => {
          if (!UpdateUserStatusCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateUserStatusSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.includes('Admin') && !ctx.user.role.includes('Master')) throw new Error('Unauthorized');
          await this.db.update(schema.users)
            .set({ active: input.active, updatedAt: new Date().toISOString() })
            .where(eq(schema.users.id, input.id));
          return { success: true };
        }),
      updateRole: protectedProcedure
        .input((val: unknown) => {
          if (!UpdateUserRoleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateUserRoleSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.includes('Admin') && !ctx.user.role.includes('Master')) throw new Error('Unauthorized');
          await this.db.update(schema.users)
            .set({ role: input.role, updatedAt: new Date().toISOString() })
            .where(eq(schema.users.id, input.id));
          return { success: true };
        }),
      adminResetPassword: protectedProcedure
        .input((val: unknown) => {
          if (!AdminResetPasswordCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AdminResetPasswordSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          if (!ctx.user.role.includes('Admin') && !ctx.user.role.includes('Master')) throw new Error('Unauthorized');
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
        return { 
          isConfigured, 
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
            throw new Error(`Failed to authenticate with Office API: ${e.message}`);
          }
        }),
    }),
    system: router({
      getTelemetry: publicProcedure.query(async () => {
        return this.sensorsService.getTelemetry();
      }),
      getActiveVoyage: publicProcedure.query(async () => {
        return this.vmsService.getActiveVoyage();
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
