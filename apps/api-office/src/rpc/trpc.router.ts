import { Injectable, Inject } from '@nestjs/common';
import { initTRPC } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, isNull, desc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as schema from '@ovl/database';
import Ajv from 'ajv';

import * as trpcExpress from '@trpc/server/adapters/express';

export const createContext = ({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions) => {
  return {
    req,
    res,
  };
};

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();
const ajv = new Ajv();

const PingSchema = Type.Object({ vesselId: Type.String() });
const PingCompiler = TypeCompiler.Compile(PingSchema);

const PushEventsSchema = Type.Object({
  vesselId: Type.String(),
  events: Type.Array(
    Type.Object({
      id: Type.String(),
      eventType: Type.String(),
      payload: Type.String(),
      createdAt: Type.String(),
      processedAt: Type.Union([Type.String(), Type.Null()]),
    })
  )
});
const PushEventsCompiler = TypeCompiler.Compile(PushEventsSchema);

const PullConfigInputSchema = Type.Object({
  lastSyncAt: Type.Optional(Type.String()),
});
const PullConfigInputCompiler = TypeCompiler.Compile(PullConfigInputSchema);

const CreateVesselSchema = Type.Object({
  name: Type.String(),
  imo: Type.String(),
  type: Type.String(),
  groups: Type.Optional(Type.Array(Type.String())),
});
const CreateVesselCompiler = TypeCompiler.Compile(CreateVesselSchema);

const UpdateVesselSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  imo: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  groups: Type.Optional(Type.Array(Type.String())),
});
const UpdateVesselCompiler = TypeCompiler.Compile(UpdateVesselSchema);

const DeleteVesselSchema = Type.Object({
  id: Type.String(),
});
const DeleteVesselCompiler = TypeCompiler.Compile(DeleteVesselSchema);

const UpdateOfficeUserSchema = Type.Object({
  id: Type.String(),
  roles: Type.Optional(Type.Array(Type.String())),
  active: Type.Optional(Type.Boolean()),
});
const UpdateOfficeUserCompiler = TypeCompiler.Compile(UpdateOfficeUserSchema);

const DeleteOfficeUserSchema = Type.Object({
  id: Type.String(),
});
const DeleteOfficeUserCompiler = TypeCompiler.Compile(DeleteOfficeUserSchema);

const GetReportSchema = Type.Object({
  reportId: Type.String(),
});
const GetReportCompiler = TypeCompiler.Compile(GetReportSchema);

const CreateApiKeySchema = Type.Object({
  label: Type.String(),
  groupId: Type.Optional(Type.String()),
});
const CreateApiKeyCompiler = TypeCompiler.Compile(CreateApiKeySchema);

const PublishSchemaSchema = Type.Object({
  schemaName: Type.String(),
  version: Type.String(),
  source: Type.String(),
  content: Type.String(),
});
const PublishSchemaCompiler = TypeCompiler.Compile(PublishSchemaSchema);

const PublishConfigBundleSchema = Type.Object({
  label: Type.Optional(Type.String()),
  schemaVersions: Type.Array(Type.Object({
    SchemaName: Type.String(),
    Version: Type.String(),
    ID: Type.String(),
  })),
  fieldPolicies: Type.Optional(Type.Array(Type.Any())),
  regulatoryProfiles: Type.Optional(Type.Array(Type.Any())),
  cadenceRules: Type.Optional(Type.Array(Type.Any())),
  ruleSeverities: Type.Optional(Type.Array(Type.Any())),
  defaultRoleNames: Type.Optional(Type.Array(Type.String())),
});
const PublishConfigBundleCompiler = TypeCompiler.Compile(PublishConfigBundleSchema);

const AssignBundleSchema = Type.Object({
  bundleId: Type.String(),
  scopeType: Type.String(),
  vesselId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  groupTag: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const AssignBundleCompiler = TypeCompiler.Compile(AssignBundleSchema);

const EnrollEdgeSchema = Type.Object({
  vesselName: Type.String(),
  imoNumber: Type.String(),
});
const EnrollEdgeCompiler = TypeCompiler.Compile(EnrollEdgeSchema);

export const publicProcedure = t.procedure;
export const router = t.router;

const isEdgeAuthed = t.middleware(async ({ ctx, next }) => {
  const authHeader = ctx.req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ovl_prod_')) {
    throw new Error('UNAUTHORIZED');
  }

  const rawToken = authHeader.split('Bearer ovl_prod_')[1];
  const tokenLookupHash = crypto.createHash('sha256').update(rawToken.substring(0, 8)).digest('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // We can't access `this.db` directly here because it's inside the TrpcRouter class.
  // We will pass the db to the middleware inside the router class!
  return next({
    ctx: {
      ...ctx,
      tokenHash,
      tokenLookupHash,
    },
  });
});

export const edgeProcedure = t.procedure.use(isEdgeAuthed);

@Injectable()
export class TrpcRouter {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  appRouter = router({
    ping: publicProcedure
      .input((val: unknown) => {
        if (!PingCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof PingSchema>;
      })
      .query(({ input }) => {
        return {
          message: `Pong received from Office API for vessel ${input.vesselId}`,
          timestamp: new Date().toISOString(),
        };
      }),

    edge: router({
      enroll: edgeProcedure
        .input((val: unknown) => {
          if (!EnrollEdgeCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof EnrollEdgeSchema>;
        })
        .mutation(async ({ input, ctx }) => {
          // 1. Verify API Key
          const keys = await this.db.select().from(schema.apiKeys)
            .where(eq(schema.apiKeys.tokenLookupHash, ctx.tokenLookupHash));
          
          if (keys.length === 0 || keys[0].tokenHash !== ctx.tokenHash || keys[0].revokedAt) {
            throw new Error('UNAUTHORIZED: Invalid or revoked API key');
          }

          // 2. Lookup Vessel by IMO
          const existing = await this.db.select().from(schema.vessels).where(eq(schema.vessels.imo, input.imoNumber));
          
          let vesselId;
          if (existing.length > 0) {
            vesselId = existing[0].id;
          } else {
            // Create implicitly
            const newVessel = await this.db.insert(schema.vessels).values({
              name: input.vesselName,
              imo: input.imoNumber,
              type: 'Cargo', // Default
              groups: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }).returning();
            vesselId = newVessel[0].id;
          }

          return { vesselId };
        }),
    }),

    sync: router({
      pushEvents: edgeProcedure
        .input((val: unknown) => {
          if (!PushEventsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PushEventsSchema>;
        })
        .mutation(async ({ input }) => {
          console.log(`Office received ${input.events.length} events from vessel ${input.vesselId}`);
          
          for (const event of input.events) {
            if (event.eventType === 'report_submitted') {
              try {
                const payload = JSON.parse(event.payload);
                await this.db.insert(schema.reportVersions).values({
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  versionNo: payload.versionNo,
                  schemaKind: payload.schemaName || 'unknown',
                  schemaVersion: '1.0',
                  eventType: payload.eventType || 'ReportSubmitted',
                  state: payload.state || 'submitted',
                  eventTime: payload.eventTime || new Date().toISOString(),
                  fields: payload.fields || {},
                  submittedAt: payload.submittedAt || new Date().toISOString(),
                  receivedAt: new Date().toISOString(),
                });
                
                await this.db.insert(schema.reportAuditEvents).values({
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  versionNo: payload.versionNo,
                  eventType: 'submitted',
                  actor: payload.submittedBy || 'vessel_master',
                  occurredAt: payload.submittedAt || new Date().toISOString(),
                  detail: {},
                  receivedAt: new Date().toISOString(),
                  origin: 'vessel',
                });
              } catch (err: any) {
                console.error('Failed to parse or save report event:', err);
              }
            }
          }
          
          return {
            success: true,
            processedCount: input.events.length,
          };
        }),

      pullConfig: edgeProcedure
        .input((val: unknown) => {
          if (!PullConfigInputCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PullConfigInputSchema>;
        })
        .query(({ input }) => {
          console.log(`Vessel requested config updates since: ${input.lastSyncAt || 'beginning of time'}`);
          
          // Here the Office API would query Postgres for any configs updated after `lastSyncAt`
          // For now, return a mock payload
          return {
            configs: [
              {
                key: 'FEATURE_FLAGS',
                value: JSON.stringify({ enableNewDashboard: true }),
                updatedAt: new Date().toISOString(),
              },
              {
                key: 'GLOBAL_SETTINGS',
                value: JSON.stringify({ maxSpeedKnots: 24 }),
                updatedAt: new Date().toISOString(),
              }
            ],
            syncedAt: new Date().toISOString(),
          };
        }),
    }),
    vessels: router({
      list: publicProcedure.query(async () => {
        const vessels = await this.db.select().from(schema.vessels);
        // Map data to match the UI expectations (with mock edgeStatus/lastSync for now since those are dynamic sync states)
        return vessels.map(v => ({
          id: v.id,
          name: v.name,
          imo: v.imo,
          type: v.type,
          status: 'At Sea', // Mocked operational status for now
          edgeStatus: 'Online', // Mocked edge node status
          lastSync: 'Just now',
          groups: v.groups,
        }));
      }),
      create: publicProcedure
        .input((val: unknown) => {
          if (!CreateVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateVesselSchema>;
        })
        .mutation(async ({ input }) => {
          const newVessel = await this.db.insert(schema.vessels).values({
            name: input.name,
            imo: input.imo,
            type: input.type,
            groups: input.groups || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }).returning();
          return newVessel[0];
        }),
      update: publicProcedure
        .input((val: unknown) => {
          if (!UpdateVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateVesselSchema>;
        })
        .mutation(async ({ input }) => {
          const { id, ...updates } = input;
          const updatedVessel = await this.db.update(schema.vessels).set({
            ...updates,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.vessels.id, id)).returning();
          return updatedVessel[0];
        }),
      delete: publicProcedure
        .input((val: unknown) => {
          if (!DeleteVesselCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof DeleteVesselSchema>;
        })
        .mutation(async ({ input }) => {
          await this.db.delete(schema.vessels).where(eq(schema.vessels.id, input.id));
          return { success: true };
        }),
    }),
    users: router({
      list: publicProcedure.query(async () => {
        const officeUsers = await this.db.select().from(schema.users);
        return officeUsers.map(u => ({
          id: u.id,
          username: u.username,
          roles: u.roles,
          active: u.active,
          createdAt: u.createdAt,
        }));
      }),
      update: publicProcedure
        .input((val: unknown) => {
          if (!UpdateOfficeUserCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof UpdateOfficeUserSchema>;
        })
        .mutation(async ({ input }) => {
          const { id, ...updates } = input;
          const updatedUser = await this.db.update(schema.users).set({
            ...updates,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.users.id, id)).returning();
          return updatedUser[0];
        }),
      delete: publicProcedure
        .input((val: unknown) => {
          if (!DeleteOfficeUserCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof DeleteOfficeUserSchema>;
        })
        .mutation(async ({ input }) => {
          await this.db.delete(schema.users).where(eq(schema.users.id, input.id));
          return { success: true };
        }),
    }),
    reports: router({
      list: publicProcedure.query(async () => {
        const reports = await this.db
          .select({
            id: schema.reportVersions.reportId,
            vesselId: schema.reportVersions.vesselId,
            versionNo: schema.reportVersions.versionNo,
            type: schema.reportVersions.eventType,
            status: schema.reportVersions.state,
            date: schema.reportVersions.receivedAt,
            vesselName: schema.vessels.name,
            vesselImo: schema.vessels.imo,
          })
          .from(schema.reportVersions)
          .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
          .limit(100);

        return reports.map(r => ({
          id: r.id,
          vessel: r.vesselName || 'Unknown',
          imo: r.vesselImo || 'Unknown',
          type: r.type,
          status: r.status,
          date: new Date(r.date).toISOString().split('T')[0],
          by: 'System',
        }));
      }),
      get: publicProcedure
        .input((val: unknown) => {
          if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof GetReportSchema>;
        })
        .query(async ({ input }) => {
          const report = await this.db
            .select({
              id: schema.reportVersions.reportId,
              vesselId: schema.reportVersions.vesselId,
              versionNo: schema.reportVersions.versionNo,
              type: schema.reportVersions.eventType,
              status: schema.reportVersions.state,
              date: schema.reportVersions.receivedAt,
              fields: schema.reportVersions.fields,
              vesselName: schema.vessels.name,
              vesselImo: schema.vessels.imo,
            })
            .from(schema.reportVersions)
            .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .limit(1);

          if (!report.length) {
            throw new Error('Report not found');
          }

          const r = report[0];
          return {
            id: r.id,
            type: r.type,
            vessel: r.vesselName || 'Unknown',
            imo: r.vesselImo || 'Unknown',
            status: r.status,
            submittedAt: r.date,
            author: 'System',
            fields: (r.fields || {}) as Record<string, any>,
          };
        }),
    }),
    apiKeys: router({
      list: publicProcedure.query(async () => {
        return await this.db.select().from(schema.apiKeys).where(isNull(schema.apiKeys.revokedAt));
      }),
      create: publicProcedure
        .input((val: unknown) => {
          if (!CreateApiKeyCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof CreateApiKeySchema>;
        })
        .mutation(async ({ input }) => {
          const rawToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
          const tokenLookupHash = crypto.createHash('sha256').update(rawToken.substring(0, 8)).digest('hex');
          
          const newKey = await this.db.insert(schema.apiKeys).values({
            label: input.label,
            tokenHash,
            tokenLookupHash,
            groupId: input.groupId || null,
            createdBy: 'System',
            createdAt: new Date().toISOString(),
          }).returning();

          return {
            key: newKey[0],
            rawToken: `ovl_prod_${rawToken}`,
          };
        }),
    }),
    dashboard: router({
      getOverview: publicProcedure.query(async () => {
        const activeVesselsResult = await this.db.select({ count: sql<number>`count(*)` }).from(schema.vessels);
        const incomingReportsResult = await this.db.select({ count: sql<number>`count(*)` }).from(schema.reportVersions);

        return {
          activeVessels: activeVesselsResult[0].count,
          incomingReports: incomingReportsResult[0].count,
          syncWarnings: 0,
          networkUptime: 99.9,
          liveStream: [
            { vessel: 'Seawise Giant', event: 'Bunker Report Received', time: 'Just now' },
            { vessel: 'Emma Maersk', event: 'Log Abstract Synced', time: '5 mins ago' },
          ]
        };
      })
    }),
    notifications: router({
      list: publicProcedure.query(async () => {
        const reports = await this.db
          .select({
            id: schema.reportVersions.reportId,
            type: schema.reportVersions.eventType,
            date: schema.reportVersions.receivedAt,
            vesselName: schema.vessels.name,
          })
          .from(schema.reportVersions)
          .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
          .orderBy(desc(schema.reportVersions.receivedAt))
          .limit(5);

        return reports.map(r => ({
          id: r.id,
          title: `New ${r.type}`,
          description: `Vessel '${r.vesselName}' synced a new draft.`,
          time: new Date(r.date).toLocaleString(),
        }));
      })
    }),
    schemas: router({
      list: publicProcedure.query(async () => {
        const results = await this.db.select().from(schema.schemaVersions).orderBy(desc(schema.schemaVersions.publishedAt));
        return results.map(r => ({
          id: r.id,
          schemaName: r.schemaName,
          version: r.version,
          source: r.source,
          publishedAt: r.publishedAt,
          publishedBy: r.publishedBy,
          content: r.content.toString('utf-8')
        }));
      }),
      publish: publicProcedure
        .input((val: unknown) => {
          if (!PublishSchemaCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PublishSchemaSchema>;
        })
        .mutation(async ({ input }) => {
          let parsed;
          try {
            parsed = JSON.parse(input.content);
          } catch (e) {
            throw new Error('Invalid JSON format');
          }
          
          if (!ajv.validateSchema(parsed)) {
            throw new Error('Invalid JSON Schema according to meta-schema');
          }

          const newSchema = await this.db.insert(schema.schemaVersions).values({
            schemaName: input.schemaName,
            version: input.version,
            source: input.source,
            content: Buffer.from(input.content, 'utf-8'),
            publishedAt: new Date().toISOString(),
            publishedBy: 'System Admin',
          }).returning();

          return newSchema[0];
        }),
    }),
    configBundles: router({
      list: publicProcedure.query(async () => {
        return await this.db.select().from(schema.configBundles).orderBy(desc(schema.configBundles.publishedAt));
      }),
      publish: publicProcedure
        .input((val: unknown) => {
          if (!PublishConfigBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PublishConfigBundleSchema>;
        })
        .mutation(async ({ input }) => {
          const newBundle = await this.db.insert(schema.configBundles).values({
            label: input.label || '',
            schemaVersions: input.schemaVersions || [],
            fieldPolicies: input.fieldPolicies || [],
            regulatoryProfiles: input.regulatoryProfiles || [],
            cadenceRules: input.cadenceRules || [],
            ruleSeverities: input.ruleSeverities || [],
            defaultRoleNames: input.defaultRoleNames || [],
            publishedAt: new Date().toISOString(),
            publishedBy: 'System Admin',
          }).returning();
          return newBundle[0];
        }),
      assign: publicProcedure
        .input((val: unknown) => {
          if (!AssignBundleCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof AssignBundleSchema>;
        })
        .mutation(async ({ input }) => {
          const assignment = await this.db.insert(schema.bundleAssignments).values({
            scopeType: input.scopeType,
            vesselId: input.vesselId || null,
            groupTag: input.groupTag || null,
            bundleId: input.bundleId,
            assignedAt: new Date().toISOString(),
          }).returning();
          return assignment[0];
        }),
      listAssignments: publicProcedure.query(async () => {
        return await this.db.select().from(schema.bundleAssignments).orderBy(desc(schema.bundleAssignments.assignedAt));
      }),
    }),
  });
}

export type AppRouter = TrpcRouter['appRouter'];
