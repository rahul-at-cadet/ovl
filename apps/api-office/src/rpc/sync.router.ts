import { TRPCError } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, gt, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { edgeProcedure, router, requireCatalogue, requireTenant } from './trpc.base';
import { withEdgeTenant } from './tenant-scope';
import { runAsSystemForTenant } from '../tenancy/tenant-context';
import { EdgeTenantResolverService } from '../tenancy/edge-tenant-resolver.service';
import { TenantDbService, type TenantDatabase } from '../tenancy/tenant-db.service';
import { TenantCatalogService } from '../form-catalogue/tenant-catalog.service';
import { ConfigBundleService } from '../config/config-bundle/config-bundle.service';
import { VesselUsersService } from '../vessels/vessel-users.service';
import { ComplianceService } from '../config/compliance/compliance.service';
import { continuityConfigFor, revalidate, type ContinuityReport, type Severity } from '../config/logic/continuity';
import { effectiveSeverities } from '../config/logic/compliance';

/**
 * The vessel-facing domains: enrollment, and the two halves of a sync cycle.
 *
 * Lifted out of the 2,400-line router so the tenancy migration can touch this
 * path in a diff someone can actually read. The procedures are unchanged — the
 * 33-test sync contract suite is what proves that, and it is the reason this
 * extraction is safe to do at all.
 *
 * Dependencies arrive as a getter because TrpcRouter composes these inside a
 * class field initializer, which runs before TypeScript assigns constructor
 * parameter properties.
 */
export interface SyncRouterDeps {
  db: NodePgDatabase<typeof schema>;
  configBundleService: ConfigBundleService;
  vesselUsersService: VesselUsersService;
  complianceService: ComplianceService;
  edgeTenants?: EdgeTenantResolverService;
  tenantDb?: TenantDbService;
  tenantCatalog?: TenantCatalogService;
}

const EnrollEdgeSchema = Type.Object({
  vesselName: Type.String(),
  imoNumber: Type.String(),
});
const EnrollEdgeCompiler = TypeCompiler.Compile(EnrollEdgeSchema);

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
  vesselId: Type.String(),
  lastSyncAt: Type.Optional(Type.String()),
  // What the vessel calls itself. Optional so a vessel on an older build
  // still checks in normally; office simply has nothing to compare against.
  vesselName: Type.Optional(Type.String()),
  imoNumber: Type.Optional(Type.String()),
  // The vessel's own id for this sync cycle, so both sides file their half
  // of one run under the same reference.
  runId: Type.Optional(Type.String()),
  // Architecture 9.3/12.4's remote user administration, piggybacked on
  // this same check-in rather than a dedicated RPC (mirrors
  // ovl/office/syncservice's SyncStatus fields of the same names): the
  // vessel's full current roster (mirrored into vessel_users wholesale)
  // and the command IDs it confirms applying since its last check-in.
  users: Type.Optional(Type.Array(Type.Object({
    username: Type.String(),
    role: Type.String(),
    active: Type.Boolean(),
    canSubmit: Type.Boolean(),
    updatedAt: Type.String(),
  }))),
  appliedUserCommandIds: Type.Optional(Type.Array(Type.String())),
  // Chat's pull-down cursor (office-authored messages only — the
  // vessel's own messages already reach office via pushEvents'
  // chat_sent handling). "0" pulls everything; chat_messages.seq is a
  // Postgres bigserial, so this arrives as a string (see the userCommand
  // seq BigInt-serialization comment on VesselUsersService).
  lastChatSeq: Type.Optional(Type.String()),
  // Remarks' pull-down cursor, same shape as lastChatSeq — remarks are
  // office-authored only (a Reviewer flags a submitted report), so there
  // is no equivalent upstream direction to worry about.
  lastRemarkSeq: Type.Optional(Type.String()),
  // Invalidation notices' pull-down cursor, same shape — computed
  // office-side only (cascade revalidation), no upstream direction.
  lastInvalidationSeq: Type.Optional(Type.String()),
});
const PullConfigInputCompiler = TypeCompiler.Compile(PullConfigInputSchema);

/**
 * Shore's half of one sync run, written into the calling vessel's own tenant
 * schema. Never allowed to break a check-in: history is diagnostic, and a
 * vessel must still sync if recording it fails.
 *
 * `db` is passed in rather than resolved here so the caller decides which
 * transaction the row belongs to. That matters for the `unknownVessel` case:
 * withEdgeTenant runs its callback in a transaction that rolls back when the
 * procedure throws, so a row written alongside the throw would vanish — which
 * is exactly the trace this table exists to keep.
 */
async function recordSyncRun(
  db: TenantDatabase,
  run: {
    runId: string | null;
    vesselId: string;
    outcome: 'served' | 'noBundle' | 'unknownVessel';
    resolvedBundleId?: string | null;
    resolvedBundleVersion?: number | null;
    reportedName: string | null;
    reportedImo: string | null;
    note?: string | null;
  },
) {
  try {
    await db.insert(schema.syncRuns).values({
      runId: run.runId,
      vesselId: run.vesselId,
      receivedAt: new Date().toISOString(),
      outcome: run.outcome,
      resolvedBundleId: run.resolvedBundleId ?? null,
      resolvedBundleVersion: run.resolvedBundleVersion ?? null,
      reportedName: run.reportedName,
      reportedImo: run.reportedImo,
      note: run.note ?? null,
    });
  } catch (err: any) {
    console.error(`Could not record sync run for vessel ${run.vesselId}:`, err?.message ?? err);
  }
}

/**
 * Re-checks every report in (vesselId, schemaName)'s chain against the
 * continuity rules (architecture 8.3) after a report version lands —
 * ports office/syncservice/cascade.go's runCascade near-verbatim. Any
 * newly (or differently) broken report flips to state "invalidated",
 * gets an audit event, and gets an invalidation_notices row for the
 * vessel to later pull. A cascade failure must not reject the outbox
 * item that already landed successfully — callers should log and
 * continue, matching PushOutbox's own "the item is accepted" contract.
 */
async function runCascade(
db: NodePgDatabase<typeof schema>,
complianceService: ComplianceService,
vesselId: string,
schemaName: string,
): Promise<void> {
  // ListChain: the latest version of every report for (vesselId,
  // schemaName), ascending by event time — corrections replace their
  // earlier version in the chain rather than adding a second entry.
  const allVersions = await db
    .select()
    .from(schema.reportVersions)
    .where(and(eq(schema.reportVersions.vesselId, vesselId), eq(schema.reportVersions.schemaKind, schemaName)));

  const latestByReportId = new Map<string, typeof allVersions[number]>();
  for (const r of allVersions) {
    const existing = latestByReportId.get(r.reportId);
    if (!existing || r.versionNo > existing.versionNo) latestByReportId.set(r.reportId, r);
  }
  // The office should never hold a draft/ready row in the first place
  // (nothing is enqueued before submit), so this is a guard, not a
  // real behavior change — kept for parity with the original's own
  // filter, since both sides must compute cascade over the same chain.
  const chainRows = Array.from(latestByReportId.values()).filter((r) => r.state !== 'draft' && r.state !== 'ready');

  // schemaKind is stored as the vessel's own schema-id convention
  // (e.g. "bunker-report.json") — stripped only here, for resolving
  // the continuity config, same normalization FieldPolicyService
  // already does; the chain query above must keep matching the
  // column's actual stored form.
  const bareSchemaName = schemaName.replace(/\.json$/, '');

  const chain: ContinuityReport[] = chainRows.map((r) => ({
    reportId: r.reportId,
    versionNo: r.versionNo,
    schemaName: bareSchemaName,
    eventType: r.eventType,
    eventTime: new Date(r.eventTime),
    fields: (r.fields as Record<string, unknown>) || {},
  }));

  const vesselRows = await db.select().from(schema.vessels).where(eq(schema.vessels.id, vesselId)).limit(1);
  const vesselGroups = (vesselRows[0]?.groups as string[] | null) ?? [];

  const assignments = await complianceService.listRuleSeverities();
  const cfg = continuityConfigFor(bareSchemaName);
  cfg.severities = effectiveSeverities(assignments, vesselId, vesselGroups) as Record<string, Severity>;

  const result = revalidate(chain, cfg);
  const now = new Date().toISOString();

  for (const row of chainRows) {
    const brokenRules = result.invalidated.get(row.reportId);
    if (!brokenRules || brokenRules.length === 0) continue;

    if (row.state === 'invalidated') {
      const prevNotice = await db
        .select()
        .from(schema.invalidationNotices)
        .where(and(eq(schema.invalidationNotices.vesselId, vesselId), eq(schema.invalidationNotices.reportId, row.reportId), eq(schema.invalidationNotices.versionNo, row.versionNo)))
        .orderBy(desc(schema.invalidationNotices.seq))
        .limit(1);
      const prevRules = (prevNotice[0]?.brokenRules as string[] | undefined) ?? [];
      if (prevRules.length === brokenRules.length && prevRules.every((r, i) => r === brokenRules[i])) {
        continue; // already recorded with the same broken rules
      }
    }

    await db
      .update(schema.reportVersions)
      .set({ state: 'invalidated' })
      .where(and(eq(schema.reportVersions.vesselId, vesselId), eq(schema.reportVersions.reportId, row.reportId), eq(schema.reportVersions.versionNo, row.versionNo)));

    await db.insert(schema.reportAuditEvents).values({
      vesselId,
      reportId: row.reportId,
      versionNo: row.versionNo,
      eventType: 'invalidated',
      actor: '',
      occurredAt: now,
      detail: { brokenRules, fromState: row.state },
      receivedAt: now,
      origin: 'office',
    });

    await db.insert(schema.invalidationNotices).values({
      vesselId,
      reportId: row.reportId,
      versionNo: row.versionNo,
      brokenRules,
      computedAt: now,
    });
  }
}

export const createEdgeRouter = (deps: () => SyncRouterDeps) =>
  router({
    enroll: edgeProcedure
      .input((val: unknown) => {
        if (!EnrollEdgeCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof EnrollEdgeSchema>;
      })
      .mutation(async ({ input, ctx }) =>
        withEdgeTenant(deps(), ctx, async (db) => {
          // 1. Verify the API key.
          // Authentication and tenant resolution both happen in withEdgeTenant,
          // which wraps this handler — the lookup hash selects the schema, the
          // full token hash authenticates, and both share this transaction.
          //
          // The vessel is looked up inside its own tenant's schema. An IMO is
          // only unique within one operator's fleet, so scoping the lookup here
          // is also what stops two tenants who happen to manage the same hull
          // from colliding on it.
          const existing = await db.select().from(schema.vessels).where(eq(schema.vessels.imo, input.imoNumber));
        
          let vesselId;
          if (existing.length > 0) {
            vesselId = existing[0].id;
          } else {
            // Create implicitly
            const newVessel = await db.insert(schema.vessels).values({
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
      ),
    });

export const createSyncRouter = (deps: () => SyncRouterDeps) =>
  router({
    pushEvents: edgeProcedure
      .input((val: unknown) => {
        if (!PushEventsCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof PushEventsSchema>;
      })
      .mutation(async ({ input, ctx }) =>
        withEdgeTenant(deps(), ctx, async (db) => {
          console.log(`Office received ${input.events.length} events from vessel ${input.vesselId}`);

          await db.insert(schema.vesselSyncStatus)
            .values({ vesselId: input.vesselId, lastSeenAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.vesselSyncStatus.vesselId,
              set: { lastSeenAt: new Date().toISOString() },
            });

          for (const event of input.events) {
            if (event.eventType === 'report_submitted') {
              try {
                const payload = JSON.parse(event.payload);
                await db.insert(schema.reportVersions).values({
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
              
                await db.insert(schema.reportAuditEvents).values({
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

                // Cascade revalidation (architecture 8.3) runs
                // synchronously right after landing, so a dependent
                // later report's invalidation is visible within this
                // same push call. A failure here must not reject an
                // item that already landed successfully. Passed as
                // stored (schema_kind carries the vessel's own
                // "bunker-report.json"-style id, .json suffix and all)
                // — runCascade strips it only where it actually matters
                // (resolving the continuity config), not for the chain
                // query itself, which must match what's in the column.
                try {
                  await runCascade(db, deps().complianceService, input.vesselId, payload.schemaName || 'unknown');
                } catch (err: any) {
                  console.error(`Cascade revalidation failed for vessel ${input.vesselId}:`, err);
                }
              } catch (err: any) {
                console.error('Failed to parse or save report event:', err);
              }
            } else if (event.eventType === 'chat_sent') {
              try {
                const payload = JSON.parse(event.payload);
                // chat_messages.direction is constrained to 'vessel'/'office'
                // (this table's schema mirrors the original Go domain's
                // ChatDirection values) — the vessel's own local SQLite
                // convention is 'ship_to_shore'/'shore_to_ship' (already
                // baked into its schema and UI), so every message is
                // translated at this sync boundary rather than picking one
                // convention and forcing it on both sides.
                await db.insert(schema.chatMessages).values({
                  id: payload.id,
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  sender: payload.sender,
                  body: payload.body,
                  sentAt: payload.sentAt || new Date().toISOString(),
                  direction: 'vessel',
                }).onConflictDoNothing();
              } catch (err: any) {
                console.error('Failed to parse or save chat message:', err);
              }
            } else if (event.eventType === 'correction_started') {
              // Architecture 8.1/8.2's "Start correction" — the vessel
              // already has version N+1 as a new local draft; this only
              // records the audit trail entry against the *old* version
              // office already has (mirrors pkg/domain.Report.NewCorrection's
              // own event placement). The new draft itself lands later,
              // as its own ordinary report_submitted push once the
              // vessel actually submits it.
              try {
                const payload = JSON.parse(event.payload);
                await db.insert(schema.reportAuditEvents).values({
                  vesselId: input.vesselId,
                  reportId: payload.reportId,
                  versionNo: payload.versionNo,
                  eventType: 'correction_started',
                  actor: payload.actor,
                  occurredAt: payload.at || new Date().toISOString(),
                  detail: { newVersionNo: payload.newVersionNo },
                  receivedAt: new Date().toISOString(),
                  origin: 'vessel',
                });
              } catch (err: any) {
                console.error('Failed to parse or save correction_started event:', err);
              }
            } else {
              console.warn(`Unrecognized outbox eventType "${event.eventType}" from vessel ${input.vesselId} — dropped.`);
            }
          }
        
          return {
            success: true,
            processedCount: input.events.length,
          };
      }),
      ),

    pullConfig: edgeProcedure
      .input((val: unknown) => {
        if (!PullConfigInputCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof PullConfigInputSchema>;
      })
      .query(async ({ input, ctx }) => {
        const result = await withEdgeTenant(deps(), ctx, async (db) => {
          // Check the vessel is actually registered before touching
          // vessel_sync_status. That table has an FK onto vessels, so an
          // unknown id used to surface as a raw Postgres foreign-key
          // violation from deep inside the insert — which the vessel then
          // swallowed, leaving "sync complete" and no bundle. A vessel
          // holding an id that shore has never heard of (office database
          // rebuilt after enrolment, vessel restored from a backup) needs
          // to be told to re-enrol, not handed a constraint error.
          //
          // Reported as a value rather than thrown from in here: this
          // transaction has to commit before the attempt can be recorded,
          // and throwing would roll that record back with it.
          const knownVessel = (
            await db
              .select()
              .from(schema.vessels)
              .where(eq(schema.vessels.id, input.vesselId))
              .limit(1)
          )[0];
          if (!knownVessel) return { unknownVessel: true as const };

          const bundle = await deps().configBundleService.resolveForVessel(input.vesselId);
          const syncedAt = new Date().toISOString();

          await db.insert(schema.vesselSyncStatus)
            .values({
              vesselId: input.vesselId,
              lastSeenAt: syncedAt,
              appliedBundleId: bundle?.bundleId ?? '',
              appliedBundleVersion: bundle?.versionNo ?? 0,
              reportedName: input.vesselName ?? null,
              reportedImo: input.imoNumber ?? null,
            })
            .onConflictDoUpdate({
              target: schema.vesselSyncStatus.vesselId,
              set: {
                lastSeenAt: syncedAt,
                appliedBundleId: bundle?.bundleId ?? '',
                appliedBundleVersion: bundle?.versionNo ?? 0,
                reportedName: input.vesselName ?? null,
                reportedImo: input.imoNumber ?? null,
              },
            });

          await recordSyncRun(db, {
            runId: input.runId ?? null,
            vesselId: input.vesselId,
            outcome: bundle ? 'served' : 'noBundle',
            resolvedBundleId: bundle?.bundleId ?? null,
            resolvedBundleVersion: bundle?.versionNo ?? null,
            reportedName: input.vesselName ?? null,
            reportedImo: input.imoNumber ?? null,
            note: bundle ? null : 'No bundle assignment covers this vessel.',
          });

          // Piggybacked on this same check-in rather than a dedicated RPC —
          // see VesselUsersService.handleCheckIn's own comment.
          const userCommands = await deps().vesselUsersService.handleCheckIn(
            input.vesselId,
            input.users,
            input.appliedUserCommandIds,
          );

          // Chat's pull-down half: office-authored messages this vessel
          // hasn't seen yet, by seq cursor. The vessel's own messages
          // already arrived via pushEvents' chat_sent handling — this
          // only needs to carry the other direction back down. Storage
          // uses 'office'/'vessel' (this table's CHECK constraint); the
          // vessel's local convention is 'ship_to_shore'/'shore_to_ship',
          // so direction is translated here at the sync boundary.
          const lastChatSeq = input.lastChatSeq ? BigInt(input.lastChatSeq) : BigInt(0);
          const newChatRows = await db
            .select()
            .from(schema.chatMessages)
            .where(
              and(
                eq(schema.chatMessages.vesselId, input.vesselId),
                eq(schema.chatMessages.direction, 'office'),
                gt(schema.chatMessages.seq, lastChatSeq),
              ),
            )
            .orderBy(schema.chatMessages.seq);
          const chatMessages = newChatRows.map((m) => ({ ...m, seq: m.seq.toString(), direction: 'shore_to_ship' }));

          // Remarks' pull-down half, same seq-cursor shape as chat —
          // remarks are always office-authored, so there's no push
          // direction to handle.
          const lastRemarkSeq = input.lastRemarkSeq ? BigInt(input.lastRemarkSeq) : BigInt(0);
          const newRemarkRows = await db
            .select()
            .from(schema.remarks)
            .where(and(eq(schema.remarks.vesselId, input.vesselId), gt(schema.remarks.seq, lastRemarkSeq)))
            .orderBy(schema.remarks.seq);
          const remarks = newRemarkRows.map((r) => ({ ...r, seq: r.seq.toString() }));

          // Invalidation notices' pull-down half, same seq-cursor shape
          // — computed office-side only (cascade revalidation), no
          // upstream direction.
          const lastInvalidationSeq = input.lastInvalidationSeq ? BigInt(input.lastInvalidationSeq) : BigInt(0);
          const newInvalidationRows = await db
            .select()
            .from(schema.invalidationNotices)
            .where(and(eq(schema.invalidationNotices.vesselId, input.vesselId), gt(schema.invalidationNotices.seq, lastInvalidationSeq)))
            .orderBy(schema.invalidationNotices.seq);
          const invalidationNotices = newInvalidationRows.map((n) => ({ ...n, seq: n.seq.toString() }));

          return {
            bundle,
            syncedAt,
            // Shore's own record of this vessel, echoed back so the ship can
            // display both names and flag a divergence locally.
            vessel: { id: knownVessel.id, name: knownVessel.name, imo: knownVessel.imo },
            userCommands,
            chatMessages,
            remarks,
            invalidationNotices,
          };
        });

        if ('unknownVessel' in result) {
          // Recorded in its own transaction, after the one above committed.
          // A vessel office cannot identify is exactly the case that used to
          // vanish without trace, so the attempt itself is the thing worth
          // keeping — sync_runs has no FK onto vessels precisely so this
          // insert can succeed.
          await withEdgeTenant(deps(), ctx, (db) =>
            recordSyncRun(db, {
              runId: input.runId ?? null,
              vesselId: input.vesselId,
              outcome: 'unknownVessel',
              reportedName: input.vesselName ?? null,
              reportedImo: input.imoNumber ?? null,
              note: 'Vessel id is not registered with this office.',
            }),
          );
          throw new TRPCError({
            code: 'NOT_FOUND',
            message:
              `Vessel ${input.vesselId} is not registered with this office. ` +
              `Re-enrol the vessel from its setup screen.`,
          });
        }

        return result;
      }),
    });
