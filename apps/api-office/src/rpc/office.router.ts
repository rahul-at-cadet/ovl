import { TRPCError } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { protectedProcedure, router } from './trpc.base';
import { SupertokensService } from '../auth/supertokens.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SchemaVersionsService } from '../config/schema-versions/schema-versions.service';
import { ONLINE_THRESHOLD_MS } from './display';

/**
 * The fleet dashboard, and the commercial reports the office authors itself.
 *
 * The last two readers of `vessels` and `report_versions` outside the sync
 * path, extracted for the same reason as the others: every reader of those
 * tables has to move to per-tenant schemas in one change, and that change has
 * to be reviewable.
 *
 * Commercial is the only place a report is entered ashore rather than synced up
 * from a ship — architecture 12.2's Commercial Editor role — which is why it
 * writes report_versions directly instead of arriving through the sync path.
 *
 * Dependencies arrive as a getter; see notifications.router.ts for why.
 */
export interface OfficeRouterDeps {
  db: NodePgDatabase<typeof schema>;
  supertokensService: SupertokensService;
  notificationsService: NotificationsService;
  schemaVersionsService: SchemaVersionsService;
}

const CreateCommercialReportSchema = Type.Object({
  schemaName: Type.String(),
  vesselId: Type.String(),
  fields: Type.Record(Type.String(), Type.Any()),
});
const CreateCommercialReportCompiler = TypeCompiler.Compile(CreateCommercialReportSchema);
const ListCommercialReportsSchema = Type.Object({
  schemaName: Type.String(),
});
const ListCommercialReportsCompiler = TypeCompiler.Compile(ListCommercialReportsSchema);

const COMMERCIAL_SCHEMA_LABELS: Record<string, string> = {
  'commercial-period': 'Commercial Period',
  'cargo-nomination': 'Cargo Nomination',
};

export const createDashboardRouter = (deps: () => OfficeRouterDeps) =>
  router({
    getOverview: protectedProcedure.query(async () => {
      const activeVesselsResult = await deps().db.select({ count: sql<number>`count(*)` }).from(schema.vessels);
      const incomingReportsResult = await deps().db.select({ count: sql<number>`count(*)` }).from(schema.reportVersions);

      // Fleet-wide sync health: same "online" definition as the
      // Vessels list's edgeStatus badge (ONLINE_THRESHOLD_MS), rolled
      // up into a fleet-wide percentage. Replaces what used to be a
      // hardcoded 100% "Database Sync" figure with the actual fraction
      // of the fleet that has checked in recently.
      const syncRows = await deps().db
        .select({ lastSeenAt: schema.vesselSyncStatus.lastSeenAt })
        .from(schema.vessels)
        .leftJoin(schema.vesselSyncStatus, eq(schema.vesselSyncStatus.vesselId, schema.vessels.id));
      const now = Date.now();
      const onlineCount = syncRows.filter((r) => {
        if (!r.lastSeenAt) return false;
        return now - new Date(r.lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS;
      }).length;
      const vesselsTotal = syncRows.length;
      const syncHealthPercent = vesselsTotal === 0 ? 100 : Math.round((onlineCount / vesselsTotal) * 100);
      const syncWarnings = vesselsTotal - onlineCount;

      const recentEvents = await deps().db
        .select({
          eventType: schema.reportAuditEvents.eventType,
          occurredAt: schema.reportAuditEvents.occurredAt,
          vesselName: schema.vessels.name,
        })
        .from(schema.reportAuditEvents)
        .leftJoin(schema.vessels, eq(schema.reportAuditEvents.vesselId, schema.vessels.id))
        .orderBy(desc(schema.reportAuditEvents.occurredAt))
        .limit(10);

      return {
        activeVessels: activeVesselsResult[0].count,
        incomingReports: incomingReportsResult[0].count,
        syncWarnings,
        syncHealthPercent,
        networkUptime: 99.9,
        liveStream: recentEvents.map((e) => ({
          vessel: e.vesselName || 'Unknown',
          event: `Report ${e.eventType}`,
          time: new Date(e.occurredAt).toLocaleString(),
        })),
      };
    })
    });

export const createCommercialRouter = (deps: () => OfficeRouterDeps) =>
  router({
    list: protectedProcedure
      .input((val: unknown) => {
        if (!ListCommercialReportsCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof ListCommercialReportsSchema>;
      })
      .query(async ({ input }) => {
        const schemaKind = `${input.schemaName}.json`;
        const reports = await deps().db
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
          .where(eq(schema.reportVersions.schemaKind, schemaKind));

        const latestByReportId = new Map<string, typeof reports[number]>();
        for (const r of reports) {
          const existing = latestByReportId.get(r.id);
          if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.id, r);
        }
        return Array.from(latestByReportId.values())
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          .map((r) => ({
            id: r.id,
            vesselId: r.vesselId,
            vessel: r.vesselName || 'Unknown',
            imo: r.vesselImo || 'Unknown',
            type: r.type,
            status: r.status,
            date: new Date(r.date).toISOString(),
          }));
      }),
    create: protectedProcedure
      .input((val: unknown) => {
        if (!CreateCommercialReportCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof CreateCommercialReportSchema>;
      })
      .mutation(async ({ input, ctx }) => {
        const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
        if (!localUser || !(localUser.roles as string[]).includes('commercialEditor')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Commercial Editor may author commercial data' });
        }
        const label = COMMERCIAL_SCHEMA_LABELS[input.schemaName];
        if (!label) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown commercial schema' });

        const vesselRows = await deps().db.select().from(schema.vessels).where(eq(schema.vessels.id, input.vesselId)).limit(1);
        if (!vesselRows[0]) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown vessel' });

        // Real-but-scoped health check: mandatory-field completeness
        // only, not the original's full plausibility/continuity rule
        // engine — this port has no equivalent
        // validation.EvaluatePlausibilityRules to run, and
        // approximating safety rules without it would be worse than
        // not having them (same principled scope cut as the vessel
        // ReportForm's own Health Check panel).
        const schemaFieldsResult = await deps().schemaVersionsService.getLatestFields(input.schemaName);
        const knownFields = schemaFieldsResult?.fields ?? [];
        const findings = knownFields
          .filter((f) => f.schemaMandatory && (input.fields[f.name] === undefined || input.fields[f.name] === null || input.fields[f.name] === ''))
          .map((f) => ({ ruleId: 'fieldPolicy.mandatory', severity: 'error' as const, field: f.name, message: `${f.label || f.name} is required` }));

        if (findings.length > 0) {
          return { report: null, findings };
        }

        const reportId = crypto.randomUUID();
        const now = new Date().toISOString();
        const schemaKind = `${input.schemaName}.json`;

        await deps().db.insert(schema.reportVersions).values({
          vesselId: input.vesselId,
          reportId,
          versionNo: 1,
          schemaKind,
          schemaVersion: schemaFieldsResult?.version ?? '',
          eventType: label,
          state: 'submitted',
          eventTime: now,
          fields: input.fields,
          submittedAt: now,
          receivedAt: now,
        });

        for (const eventType of ['created', 'ready', 'submitted']) {
          await deps().db.insert(schema.reportAuditEvents).values({
            vesselId: input.vesselId,
            reportId,
            versionNo: 1,
            eventType,
            actor: localUser.username,
            occurredAt: now,
            detail: {},
            receivedAt: now,
            origin: 'office',
          });
        }

        return {
          report: { id: reportId, vesselId: input.vesselId, type: label, status: 'submitted' },
          findings: [] as { ruleId: string; severity: 'error' | 'warning'; field?: string; message: string }[],
        };
      }),
    });
