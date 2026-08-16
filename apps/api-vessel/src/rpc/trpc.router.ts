import { Injectable, Inject } from '@nestjs/common';
import { initTRPC } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ReportsService } from '../reports/reports.service';
import { SchemaRegistryService } from '../reports/schema-registry.service';
import { SensorsService } from '../sensors/sensors.service';
import { VmsService } from '../sensors/vms.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';

const t = initTRPC.create();
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

const UpdateSettingsSchema = Type.Record(Type.String(), Type.String());
const UpdateSettingsCompiler = TypeCompiler.Compile(UpdateSettingsSchema);

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly schemaRegistryService: SchemaRegistryService,
    private readonly sensorsService: SensorsService,
    private readonly vmsService: VmsService,
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
      createReport: publicProcedure
        .input((val: unknown) => {
          if (!CreateReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateReportSchema>;
        })
        .mutation(async ({ input }) => {
          // Hardcoded user for edge node without auth guard
          const username = 'vessel-admin';
          return this.reportsService.createReport(input, username);
        }),
      listReports: publicProcedure
        .input((val: unknown) => {
          if (!ListReportsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof ListReportsSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.listReports(input.schemaName);
        }),
      getReport: publicProcedure
        .input((val: unknown) => {
          if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetReportSchema>;
        })
        .query(async ({ input }) => {
          return this.reportsService.getReport(input.id);
        }),
      saveSection: publicProcedure
        .input((val: unknown) => {
          if (!SaveSectionCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SaveSectionSchema>;
        })
        .mutation(async ({ input }) => {
          const username = 'vessel-admin';
          return this.reportsService.saveSection(
            input.id,
            { section: input.section, changes: input.changes },
            username,
          );
        }),
      submitReport: publicProcedure
        .input((val: unknown) => {
          if (!SubmitReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof SubmitReportSchema>;
        })
        .mutation(async ({ input }) => {
          const username = 'vessel-admin';
          return this.reportsService.submitReport(input.id, username);
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
      getSchema: publicProcedure
        .input((val: unknown) => {
          if (!GetSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetSchemaInputSchema>;
        })
        .query(async ({ input }) => {
          return this.schemaRegistryService.getSchema(input.schemaName);
        }),
    }),
    users: router({
      list: publicProcedure.query(() => {
        // Edge node currently has no complex auth/roles DB, return default admin users
        return [
          { id: '1', username: 'vessel-admin', role: 'Master', active: true },
          { id: '2', username: 'chief-engineer', role: 'Chief Engineer', active: true },
          { id: '3', username: 'second-officer', role: 'Second Officer', active: true }
        ];
      }),
    }),
    setup: router({
      status: publicProcedure.query(async () => {
        // Check if device is configured by looking for vessel_id in configStore
        const result = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'vessel_id'));
        // If we don't have a vessel_id, the edge node is not configured yet
        const isConfigured = result.length > 0;
        return { isConfigured, vesselId: isConfigured ? result[0].value : null };
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
