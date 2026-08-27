import { TRPCError } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { protectedProcedure, router } from './trpc.base';
import { withTenantDb } from './tenant-scope';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { SupertokensService } from '../auth/supertokens.service';

/**
 * The reports ledger: submitted report versions, their review state, remarks
 * and the per-report chat between office and vessel.
 *
 * The other major reader of the tables the sync path writes. It is extracted
 * alongside `sync` and `vessels` because all three touch `report_versions` and
 * `vessels`, and those move to per-tenant schemas together or not at all — a
 * half-migrated set would have vessels pushing into one schema while the office
 * ledger reads another.
 *
 * Dependencies arrive as a getter; see notifications.router.ts for why.
 */
export interface ReportsRouterDeps {
  db: NodePgDatabase<typeof schema>;
  tenantDb?: TenantDbService;
  supertokensService: SupertokensService;
}

// Architecture 12.3: "text-only, size-capped" — enforced on every write
// path on both sides (mirrors pkg/domain.MaxChatBodyBytes), so the cap
// can't drift between office's and the vessel's send paths.
const MAX_CHAT_BODY_BYTES = 4096;

const CreateRemarkSetSchema = Type.Object({
  reportId: Type.String(),
  remarks: Type.Array(Type.Object({ fieldName: Type.String(), body: Type.String() }), { minItems: 1 }),
});
const CreateRemarkSetCompiler = TypeCompiler.Compile(CreateRemarkSetSchema);

const GetChatSchema = Type.Object({ reportId: Type.String() });
const GetChatCompiler = TypeCompiler.Compile(GetChatSchema);

const GetReportSchema = Type.Object({
  reportId: Type.String(),
});
const GetReportCompiler = TypeCompiler.Compile(GetReportSchema);

const ListRemarksSchema = Type.Object({ reportId: Type.String() });
const ListRemarksCompiler = TypeCompiler.Compile(ListRemarksSchema);

const MarkReviewedSchema = Type.Object({
  reportId: Type.String(),
});
const MarkReviewedCompiler = TypeCompiler.Compile(MarkReviewedSchema);

const SendChatMessageSchema = Type.Object({ reportId: Type.String(), body: Type.String() });
const SendChatMessageCompiler = TypeCompiler.Compile(SendChatMessageSchema);

const SetRemarkResolvedSchema = Type.Object({ id: Type.String(), resolved: Type.Boolean() });
const SetRemarkResolvedCompiler = TypeCompiler.Compile(SetRemarkResolvedSchema);

export const createReportsRouter = (deps: () => ReportsRouterDeps) =>
  router({
    list: protectedProcedure.query(async () =>
      withTenantDb(deps().tenantDb, async (db) => {
        const reports = await db
          .select({
            id: schema.reportVersions.reportId,
            vesselId: schema.reportVersions.vesselId,
            versionNo: schema.reportVersions.versionNo,
            type: schema.reportVersions.eventType,
            status: schema.reportVersions.state,
            date: schema.reportVersions.receivedAt,
            vesselName: schema.vessels.name,
            vesselImo: schema.vessels.imo,
            reviewedBy: schema.reportReviews.reviewedBy,
          })
          .from(schema.reportVersions)
          .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
          .leftJoin(
            schema.reportReviews,
            and(
              eq(schema.reportReviews.vesselId, schema.reportVersions.vesselId),
              eq(schema.reportReviews.reportId, schema.reportVersions.reportId),
            ),
          );

        // Corrections (Report.startCorrection) mean a reportId can now
        // have more than one row here — keep only the highest versionNo
        // per reportId, so a corrected report shows once, as its current
        // state, not once per historical version.
        const latestByReportId = new Map<string, typeof reports[number]>();
        for (const r of reports) {
          const existing = latestByReportId.get(r.id);
          if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.id, r);
        }

        return Array.from(latestByReportId.values())
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          .slice(0, 100)
          .map(r => ({
            id: r.id,
            vessel: r.vesselName || 'Unknown',
            imo: r.vesselImo || 'Unknown',
            type: r.type,
            status: r.status,
            date: new Date(r.date).toISOString().split('T')[0],
            by: 'System',
            reviewed: !!r.reviewedBy,
          }));
    }),
    ),
    // The original's own CSV export (office/httpapi/csvexport.go) is
    // API-key-gated for external/compliance tooling, not a dashboard
    // button — it has no UI trigger anywhere in the original app. This
    // is the session-authenticated equivalent of what a user clicking
    // "Export Report" would actually expect: the full ledger (not
    // capped at 100 rows like the list view) as a CSV, returned as
    // text rather than a file download since this app's session
    // transport is header-based (getTokenTransferMethod: 'header') —
    // a plain <a href> or window.open download couldn't carry the
    // auth header, but the tRPC client's fetch already does.
    exportCsv: protectedProcedure.query(async () =>
      withTenantDb(deps().tenantDb, async (db) => {
        const reports = await db
          .select({
            id: schema.reportVersions.reportId,
            versionNo: schema.reportVersions.versionNo,
            type: schema.reportVersions.eventType,
            status: schema.reportVersions.state,
            date: schema.reportVersions.receivedAt,
            vesselName: schema.vessels.name,
            vesselImo: schema.vessels.imo,
            reviewedBy: schema.reportReviews.reviewedBy,
          })
          .from(schema.reportVersions)
          .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
          .leftJoin(
            schema.reportReviews,
            and(
              eq(schema.reportReviews.vesselId, schema.reportVersions.vesselId),
              eq(schema.reportReviews.reportId, schema.reportVersions.reportId),
            ),
          );

        const latestByReportId = new Map<string, typeof reports[number]>();
        for (const r of reports) {
          const existing = latestByReportId.get(r.id);
          if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.id, r);
        }

        const rows = Array.from(latestByReportId.values()).sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        );

        const escapeCsv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const header = ['Report ID', 'Vessel', 'IMO', 'Type', 'Status', 'Date Received', 'Reviewed'];
        const lines = [header.join(',')];
        for (const r of rows) {
          lines.push(
            [
              r.id,
              r.vesselName || 'Unknown',
              r.vesselImo || 'Unknown',
              r.type,
              r.status,
              new Date(r.date).toISOString().split('T')[0],
              r.reviewedBy ? 'Yes' : 'No',
            ]
              .map((v) => escapeCsv(String(v)))
              .join(','),
          );
        }

        return { csv: lines.join('\n'), filename: `fleet-reports-${new Date().toISOString().split('T')[0]}.csv` };
    }),
    ),
    get: protectedProcedure
      .input((val: unknown) => {
        if (!GetReportCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof GetReportSchema>;
      })
      .query(async ({ input }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          const report = await db
            .select({
              id: schema.reportVersions.reportId,
              vesselId: schema.reportVersions.vesselId,
              versionNo: schema.reportVersions.versionNo,
              type: schema.reportVersions.eventType,
              schemaKind: schema.reportVersions.schemaKind,
              status: schema.reportVersions.state,
              date: schema.reportVersions.receivedAt,
              fields: schema.reportVersions.fields,
              vesselName: schema.vessels.name,
              vesselImo: schema.vessels.imo,
            })
            .from(schema.reportVersions)
            .leftJoin(schema.vessels, eq(schema.reportVersions.vesselId, schema.vessels.id))
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .orderBy(desc(schema.reportVersions.versionNo))
            .limit(1);

          if (!report.length) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
          }

          const r = report[0];

          // Specifically the submit event, not just "whatever audit event
          // happened most recently" — a report can pick up later event
          // types (remarked, invalidated, ...) against the same
          // reportId+versionNo, and the most recent one isn't necessarily
          // who submitted it. Found via Remarks: after a Reviewer flagged
          // a field, this used to relabel "Submitted By" as the Reviewer.
          const submitEvent = await db
            .select({ actor: schema.reportAuditEvents.actor })
            .from(schema.reportAuditEvents)
            .where(
              and(
                eq(schema.reportAuditEvents.reportId, r.id),
                eq(schema.reportAuditEvents.versionNo, r.versionNo),
                eq(schema.reportAuditEvents.eventType, 'submitted'),
              ),
            )
            .orderBy(desc(schema.reportAuditEvents.occurredAt))
            .limit(1);

          const review = await db
            .select({ reviewedBy: schema.reportReviews.reviewedBy, reviewedAt: schema.reportReviews.reviewedAt })
            .from(schema.reportReviews)
            .where(
              and(
                eq(schema.reportReviews.vesselId, r.vesselId),
                eq(schema.reportReviews.reportId, r.id),
              ),
            )
            .limit(1);

          // report_versions carries no invalidatedRules column of its
          // own (unlike the vessel's local schema) — the
          // invalidation_notices log is the source of truth, so the
          // latest one for this exact version is looked up only when
          // actually needed for display.
          let brokenRules: string[] | null = null;
          if (r.status === 'invalidated') {
            const notice = await db
              .select({ brokenRules: schema.invalidationNotices.brokenRules })
              .from(schema.invalidationNotices)
              .where(
                and(
                  eq(schema.invalidationNotices.vesselId, r.vesselId),
                  eq(schema.invalidationNotices.reportId, r.id),
                  eq(schema.invalidationNotices.versionNo, r.versionNo),
                ),
              )
              .orderBy(desc(schema.invalidationNotices.seq))
              .limit(1);
            brokenRules = (notice[0]?.brokenRules as string[] | undefined) ?? null;
          }

          return {
            id: r.id,
            vesselId: r.vesselId,
            type: r.type,
            schemaKind: r.schemaKind,
            vessel: r.vesselName || 'Unknown',
            imo: r.vesselImo || 'Unknown',
            status: r.status,
            submittedAt: r.date,
            author: submitEvent[0]?.actor || 'System',
            fields: (r.fields || {}) as Record<string, any>,
            reviewed: review.length > 0,
            reviewedBy: review[0]?.reviewedBy ?? null,
            reviewedAt: review[0]?.reviewedAt ?? null,
            brokenRules,
          };
      }),
      ),
    // Mirrors the original OVL product's reviewer workflow: office staff can
    // mark a report as looked-at ("triage"), which is a bookkeeping flag,
    // not a state transition — there is no approve/reject concept for
    // reports in the source product (see office/store/reportreviews.go).
    markReviewed: protectedProcedure
      .input((val: unknown) => {
        if (!MarkReviewedCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof MarkReviewedSchema>;
      })
      .mutation(async ({ input, ctx }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          const latest = await db
            .select({ vesselId: schema.reportVersions.vesselId })
            .from(schema.reportVersions)
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .limit(1);
          if (!latest.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
          const vesselId = latest[0].vesselId;

          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const reviewedBy = localUser?.username || 'unknown';

          await db
            .insert(schema.reportReviews)
            .values({
              vesselId,
              reportId: input.reportId,
              reviewedBy,
              reviewedAt: new Date().toISOString(),
            })
            .onConflictDoUpdate({
              target: [schema.reportReviews.vesselId, schema.reportReviews.reportId],
              set: { reviewedBy, reviewedAt: new Date().toISOString() },
            });

          return { reviewed: true, reviewedBy };
      }),
      ),
    // Architecture 12.3/design handoff B4's per-report chat wall —
    // mirrors the vessel side's reports.getChat/sendChatMessage
    // (apps/api-vessel/src/reports/reports.service.ts) so both apps
    // expose the same shape. Chat is viewable/sendable by any
    // authenticated office user, same as the original (not
    // Reviewer-gated the way remarks are).
    getChat: protectedProcedure
      .input((val: unknown) => {
        if (!GetChatCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof GetChatSchema>;
      })
      .query(async ({ input }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          const rows = await db
            .select()
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.reportId, input.reportId))
            .orderBy(schema.chatMessages.sentAt);
          return rows.map((m) => ({ ...m, seq: m.seq.toString() }));
      }),
      ),
    sendChatMessage: protectedProcedure
      .input((val: unknown) => {
        if (!SendChatMessageCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof SendChatMessageSchema>;
      })
      .mutation(async ({ input, ctx }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          if (Buffer.byteLength(input.body, 'utf8') > MAX_CHAT_BODY_BYTES) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `Chat message body exceeds the ${MAX_CHAT_BODY_BYTES} byte limit.` });
          }
          const latest = await db
            .select({ vesselId: schema.reportVersions.vesselId })
            .from(schema.reportVersions)
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .limit(1);
          if (!latest.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });

          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          const sender = localUser?.username || 'office';

          const rows = await db
            .insert(schema.chatMessages)
            .values({
              id: crypto.randomUUID(),
              vesselId: latest[0].vesselId,
              reportId: input.reportId,
              sender,
              body: input.body,
              sentAt: new Date().toISOString(),
              direction: 'office',
            })
            .returning();
          return { ...rows[0], seq: rows[0].seq.toString() };
      }),
      ),
    // Design handoff B4's "send remark set" (architecture 12.3): a
    // Reviewer flags one or more fields on the report's latest version
    // with comments, in a single call — mirrors
    // ovl/office/httpapi/remarks.go's handleCreateRemarkSet, minus the
    // human-readable field-label resolution (this port's office side
    // has no schema registry to resolve labels from; the chat summary
    // falls back to raw field names, same as the original does when a
    // schema can't be loaded).
    createRemarkSet: protectedProcedure
      .input((val: unknown) => {
        if (!CreateRemarkSetCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof CreateRemarkSetSchema>;
      })
      .mutation(async ({ input, ctx }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          if (!localUser || !(localUser.roles as string[]).includes('reviewer')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a Reviewer may flag fields with remarks.' });
          }

          const latest = await db
            .select({ vesselId: schema.reportVersions.vesselId, versionNo: schema.reportVersions.versionNo, state: schema.reportVersions.state })
            .from(schema.reportVersions)
            .where(eq(schema.reportVersions.reportId, input.reportId))
            .orderBy(desc(schema.reportVersions.versionNo))
            .limit(1);
          if (!latest.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' });
          const { vesselId, versionNo, state } = latest[0];
          // Mirrors pkg/domain.Report.MarkRemarked's own guard: a report
          // still in draft/ready hasn't been submitted for review yet.
          if (state === 'draft' || state === 'ready') {
            throw new TRPCError({ code: 'CONFLICT', message: `Cannot remark a report in state "${state}"; it must be submitted first.` });
          }

          const author = localUser.username;
          const now = new Date().toISOString();
          const remarkSetId = crypto.randomUUID();
          const fieldNames = input.remarks.map((r) => r.fieldName);

          const insertedRemarks = await db
            .insert(schema.remarks)
            .values(
              input.remarks.map((r) => ({
                id: crypto.randomUUID(),
                remarkSetId,
                vesselId,
                reportId: input.reportId,
                versionNo,
                fieldName: r.fieldName,
                body: r.body,
                author,
                createdAt: now,
                resolved: false,
              })),
            )
            .returning();

          await db
            .update(schema.reportVersions)
            .set({ state: 'remarked' })
            .where(and(eq(schema.reportVersions.vesselId, vesselId), eq(schema.reportVersions.reportId, input.reportId), eq(schema.reportVersions.versionNo, versionNo)));

          await db.insert(schema.reportAuditEvents).values({
            vesselId,
            reportId: input.reportId,
            versionNo,
            eventType: 'remarked',
            actor: author,
            occurredAt: now,
            detail: { fields: fieldNames },
            receivedAt: now,
            origin: 'office',
          });

          // Phase 5 restructure: since the standalone Remarks tab is
          // gone client-side, a remark set also auto-posts a linking
          // chat message — otherwise a remark would land with no trace
          // in the surface that replaced it (see reports.sendChatMessage
          // above for the same insert shape).
          const shown = fieldNames.slice(0, 3);
          const suffix = fieldNames.length > 3 ? ` (+${fieldNames.length - 3} more)` : '';
          let summary = `Flagged: ${shown.join(', ')}${suffix}`;
          if (input.remarks.length === 1) summary += `\n${input.remarks[0].body}`;
          if (Buffer.byteLength(summary, 'utf8') > MAX_CHAT_BODY_BYTES) {
            summary = Buffer.from(summary, 'utf8').subarray(0, MAX_CHAT_BODY_BYTES).toString('utf8');
          }
          await db.insert(schema.chatMessages).values({
            id: crypto.randomUUID(),
            vesselId,
            reportId: input.reportId,
            sender: author,
            body: summary,
            sentAt: now,
            direction: 'office',
          });

          return insertedRemarks.map((r) => ({ ...r, seq: r.seq.toString() }));
      }),
      ),
    listRemarks: protectedProcedure
      .input((val: unknown) => {
        if (!ListRemarksCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof ListRemarksSchema>;
      })
      .query(async ({ input }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          const rows = await db
            .select()
            .from(schema.remarks)
            .where(eq(schema.remarks.reportId, input.reportId))
            .orderBy(schema.remarks.createdAt);
          return rows.map((r) => ({ ...r, seq: r.seq.toString() }));
      }),
      ),
    // Reviewer-only manual toggle (Phase 5 open question 2's resolved
    // default: no auto-infer from a later synced value).
    setRemarkResolved: protectedProcedure
      .input((val: unknown) => {
        if (!SetRemarkResolvedCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof SetRemarkResolvedSchema>;
      })
      .mutation(async ({ input, ctx }) =>
        withTenantDb(deps().tenantDb, async (db) => {
          const localUser = await deps().supertokensService.getLocalUser(ctx.session.getUserId());
          if (!localUser || !(localUser.roles as string[]).includes('reviewer')) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a Reviewer may resolve remarks.' });
          }
          await db
            .update(schema.remarks)
            .set({ resolved: input.resolved, resolvedAt: input.resolved ? new Date().toISOString() : null })
            .where(eq(schema.remarks.id, input.id));
          return { resolved: input.resolved };
      }),
      ),
    });
