import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TrpcService } from '../rpc/trpc.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { isNull, eq, and, desc, sql } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { AuthService } from '../auth/auth.service';
import { RestoreBundleService } from '../system/restore-bundle.service';
import { SchemaRegistryService } from '../reports/schema-registry.service';
import { randomUUID } from 'crypto';

/** One recorded sync cycle, as stored in the vessel's `sync_runs` table. */
export interface SyncRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  trigger: string;
  pushError: string | null;
  configError: string | null;
  configNotice: string | null;
  pushedCount: number;
  bundleIdBefore: string | null;
  bundleIdAfter: string | null;
  bundleVersionAfter: number | null;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private isSyncing = false;
  private lastSuccess: string | null = null;
  private lastError: string | null = null;
  // Per-phase outcomes. A cycle used to report success whenever it merely
  // finished: both phases caught their own errors and never rethrew, so
  // handleCron's success path ran regardless and cleared lastError. A vessel
  // failing every config pull — wrong shore URL, unknown vessel id — showed
  // "Sync complete" indefinitely with nothing anywhere to contradict it.
  private lastPushError: string | null = null;
  private lastConfigError: string | null = null;
  // Set when shore answers the check-in but has no bundle for this vessel.
  // Distinct from an error: the round trip worked, there is simply nothing
  // assigned, and telling those two apart is the whole point.
  private lastConfigNotice: string | null = null;
  private lastPushedCount = 0;
  private currentRunId: string | null = null;

  constructor(
    private readonly trpc: TrpcService,
    private readonly authService: AuthService,
    private readonly restoreBundleService: RestoreBundleService,
    private readonly schemaRegistryService: SchemaRegistryService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: any, // type as NodePgDatabase/BetterSQLite3Database if configured
  ) {}

  /**
   * The Sync Engine Loop
   * Runs every 30 seconds to push local changes to shore and pull new configs from shore.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron(trigger: 'cron' | 'manual' = 'cron') {
    if (this.isSyncing) return;
    this.isSyncing = true;

    // One id per cycle, minted here and carried to shore on the check-in so
    // both sides file their half of the same run under the same reference.
    this.currentRunId = randomUUID();
    const startedAt = new Date().toISOString();
    const bundleIdBefore = (await this.readStoredBundle())?.bundleId ?? null;

    try {
      this.logger.debug('Starting Sync Cycle...');

      // Both phases still run even when the other fails — a config pull
      // must not be skipped because an unrelated outbox push broke — but
      // their failures are now collected rather than discarded, and the
      // cycle only counts as a success when both actually succeeded.
      this.lastPushError = null;
      this.lastConfigError = null;
      this.lastConfigNotice = null;
      this.lastPushedCount = 0;

      // 1. Upstream Sync (Ship -> Shore)
      await this.pushOutboxEvents();

      // 2. Downstream Sync (Shore -> Ship)
      await this.pullConfiguration();

      const failures = [this.lastPushError, this.lastConfigError].filter(Boolean);
      if (failures.length > 0) {
        this.lastError = failures.join(' · ');
        this.logger.warn(`Sync Cycle finished with errors: ${this.lastError}`);
      } else {
        this.logger.debug('Sync Cycle Complete');
        this.lastSuccess = new Date().toISOString();
        this.lastError = null;
      }
    } catch (error: any) {
      this.logger.error(`Sync cycle failed: ${error.message}`);
      this.lastError = error.message;
    } finally {
      // Recorded in `finally` so a cycle that threw outright still leaves a
      // row. History that only covers the runs which went well is precisely
      // the history that could not have caught this class of bug.
      await this.recordRun(startedAt, trigger, bundleIdBefore);
      this.isSyncing = false;
    }
  }

  /** The stored bundle, or undefined when the vessel holds none. */
  private async readStoredBundle(): Promise<{ bundleId?: string; versionNo?: number } | undefined> {
    const row = (
      await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'config_bundle'))
    )[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }

  private async recordRun(startedAt: string, trigger: 'cron' | 'manual', bundleIdBefore: string | null) {
    const after = await this.readStoredBundle();
    const outcome = this.lastError
      ? this.lastPushError && this.lastConfigError
        ? 'failed'
        : 'partial'
      : 'success';
    try {
      await this.db.insert(schema.syncRuns).values({
        id: this.currentRunId ?? randomUUID(),
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome,
        trigger,
        pushError: this.lastPushError,
        configError: this.lastConfigError,
        configNotice: this.lastConfigNotice,
        pushedCount: this.lastPushedCount,
        bundleIdBefore,
        bundleIdAfter: after?.bundleId ?? null,
        bundleVersionAfter: after?.versionNo ?? null,
      });
      // Keep the log bounded — this table is written every 30 seconds.
      await this.db.run(
        sql`DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT 200)`,
      );
    } catch (err: any) {
      // History must never be able to break syncing itself.
      this.logger.error(`Could not record sync run: ${err.message}`);
    }
  }

  /**
   * Most recent cycles, newest first — backs the vessel's sync timeline.
   *
   * The return type is spelled out rather than inferred: `db` is typed `any`
   * here, so an inferred return collapses to `any` and every consumer of this
   * procedure silently loses its types (the frontend's `.map()` callback then
   * fails `noImplicitAny` only at `next build`, never in dev).
   */
  async getHistory(limit = 50): Promise<SyncRunRecord[]> {
    return this.db
      .select()
      .from(schema.syncRuns)
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(Math.min(limit, 200));
  }

  async getStatus() {
    // One read of the whole store rather than a query per key — the vessel's
    // identity, the shore URL and the applied bundle all live here.
    const configRows = await this.db.select().from(schema.configStore);
    const config: Record<string, string> = {};
    for (const row of configRows) config[row.key] = row.value;

    const enrolled = !!config['vessel_id'];

    // Real outbox depth, not a placeholder: the same isNull(processedAt)
    // filter pushOutboxEvents itself uses to find what still needs
    // pushing to shore.
    const pending = await this.db
      .select()
      .from(schema.syncOutbox)
      .where(isNull(schema.syncOutbox.processedAt));

    // What this vessel is actually running, read back from the stored
    // bundle rather than from whatever the last cycle happened to see.
    // "Enrolled and syncing but holding no bundle" is a real, reachable
    // state and the one worth surfacing loudest.
    let appliedBundleId: string | null = null;
    let appliedBundleVersion: number | null = null;
    let appliedAt: string | null = null;
    const bundleRow = configRows.find((r: { key: string }) => r.key === 'config_bundle');
    if (bundleRow) {
      try {
        const parsed = JSON.parse(bundleRow.value);
        appliedBundleId = parsed?.bundleId ?? null;
        appliedBundleVersion = parsed?.versionNo ?? null;
        appliedAt = bundleRow.updatedAt ?? null;
      } catch {
        this.lastConfigError ??= 'Stored config bundle is not readable JSON.';
      }
    }

    return {
      enrolled,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      pendingCount: pending.length,
      // Identity, so the vessel can show who it thinks it is and office can
      // be checked against it. Until now the vessel's own name lived only in
      // the setup wizard and appeared nowhere else in the app.
      vesselId: config['vessel_id'] ?? null,
      vesselName: config['vessel_name'] ?? null,
      imoNumber: config['imo_number'] ?? config['imoNumber'] ?? null,
      shoreUrl: config['shore_url'] ?? null,
      // What shore calls this same vessel, captured on the last successful
      // check-in. A mismatch is legitimate and permanent — edge.enroll
      // matches on IMO and ignores the name the vessel sent — so it has to
      // be shown rather than silently reconciled.
      officeVesselName: config['office_vessel_name'] ?? null,
      officeImoNumber: config['office_imo_number'] ?? null,
      nameMismatch:
        !!config['office_vessel_name'] &&
        !!config['vessel_name'] &&
        config['office_vessel_name'] !== config['vessel_name'],
      appliedBundleId,
      appliedBundleVersion,
      appliedAt,
      configNotice: this.lastConfigNotice,
      pushError: this.lastPushError,
      configError: this.lastConfigError,
    };
  }

  async syncNow() {
    await this.handleCron('manual');
    return this.getStatus();
  }

  private async pushOutboxEvents() {
    // Find all events in the local SQLite db that haven't been processed
    const pendingEvents = await this.db
      .select()
      .from(schema.syncOutbox)
      .where(isNull(schema.syncOutbox.processedAt));

    if (pendingEvents.length === 0) return;

    this.logger.log(
      `Found ${pendingEvents.length} pending events in outbox. Pushing to shore...`,
    );

    try {
      // 1. Send to Office API via tRPC
      const status = await this.getStatus();
      const vesselId = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'vessel_id')))[0]?.value || 'vessel-123';
      
      const response =
        await this.trpc.client.sync.pushEvents.mutate({ vesselId, events: pendingEvents });

      if (response.success) {
        // Office reports per-event failures (e.g. a malformed payload) in
        // failedIds rather than rejecting the whole batch — those events
        // never actually landed, so marking them processed here would
        // delete them from the outbox with no record anywhere. Leaving
        // them unprocessed means they're retried next cycle, same as an
        // outright request failure.
        // `event` is annotated rather than inferred: `db` is typed `any`
        // here, so pendingEvents is any[] and the callback param would be
        // an implicit any — which api-vessel's own build tolerates but
        // web-vessel's stricter type-check (it pulls this file in via the
        // tRPC AppRouter type) rejects at `next build`.
        const failedIds = new Set<string>(response.failedIds ?? []);
        const succeeded = pendingEvents.filter((event: { id: string }) => !failedIds.has(event.id));

        this.logger.log(
          `Successfully pushed ${response.processedCount} events. Marking locally as processed.`,
        );
        this.lastPushedCount = response.processedCount ?? succeeded.length;
        if (failedIds.size > 0) {
          this.lastPushError = `${failedIds.size} event(s) rejected by office; will retry next cycle.`;
          this.logger.warn(this.lastPushError);
        }

        // 2. Mark as processed locally so they aren't sent again
        const now = new Date().toISOString();
        for (const event of succeeded) {
          await this.db
            .update(schema.syncOutbox)
            .set({ processedAt: now })
            .where(eq(schema.syncOutbox.id, event.id));
        }
      }
    } catch (err: any) {
      this.lastPushError = `Push failed: ${err.message}`;
      this.logger.error(`Failed to push outbox events: ${err.message}`);
    }
  }

  /**
   * Architecture 9.3/12.4's remote user administration, pull side —
   * ported from ovl/vessel/httpapi/sync.go's applyPulledUserCommands.
   * Applies each pulled UserCommand independently; a command that fails
   * here is deliberately left OFF appliedIds so it is never acked as
   * applied — office's Manage Users dialog keeps showing it as "Queued"
   * forever, which is the correct signal for an Admin to notice and
   * investigate (e.g. a duplicate username), rather than a failure being
   * silently swallowed and misreported as success. This does mean a
   * permanently-failing command (like a duplicate create) is redelivered
   * and retried every cycle indefinitely — accepted per the original's
   * own reasoning, since each retry is a harmless no-op until an
   * operator resolves the underlying conflict from office.
   */
  private async applyUserCommands(commands: any[]): Promise<string[]> {
    const appliedIds: string[] = [];
    for (const cmd of commands) {
      try {
        await this.authService.applyUserCommand(cmd);
        this.logger.log(`Applied user command ${cmd.id} (${cmd.action} ${cmd.username}).`);
        appliedIds.push(cmd.id);
      } catch (err: any) {
        this.logger.error(`Failed to apply user command ${cmd.id} (${cmd.action} ${cmd.username}): ${err.message}`);
      }
    }
    return appliedIds;
  }

  /**
   * Chat's pull-down half: inserts office-authored (shore_to_ship)
   * messages pulled this cycle. ON CONFLICT DO NOTHING on id makes a
   * re-pull idempotent — the cursor advance below is the normal path,
   * but a crash between insert and cursor-save must not duplicate rows
   * on retry.
   *
   * sentAt is normalized to the same new Date().toISOString() format
   * the vessel's own local writes use (reports.service.ts's
   * sendChatMessage) — SQLite has no real datetime type, so
   * ListChatMessages' ORDER BY sentAt is a plain string comparison.
   * Postgres's timestamptz serializes as "2026-08-20 06:43:22.089+00"
   * (space before the time), which sorts *before* any ISO
   * "T"-separated string lexicographically regardless of actual time —
   * without this normalization, every office-authored message would
   * render above strictly-earlier vessel messages in the chat thread.
   */
  private async applyChatMessages(messages: any[]): Promise<string | null> {
    let maxSeq: bigint | null = null;
    for (const m of messages) {
      await this.db.insert(schema.chatMessages).values({
        id: m.id,
        reportId: m.reportId,
        sender: m.sender,
        body: m.body,
        sentAt: new Date(m.sentAt).toISOString(),
        direction: m.direction,
      }).onConflictDoNothing();
      const seq = BigInt(m.seq);
      if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    }
    return maxSeq === null ? null : maxSeq.toString();
  }

  /**
   * Remarks' pull-down half — office is the only author, so this is
   * pure apply, no push side. Mirrors pkg/domain.Report.MarkRemarked:
   * inserting a remark also flips the local report version's state to
   * "remarked" (per that exact reportId+versionNo, not necessarily the
   * report's current latest version — a correction may have already
   * moved on since the reviewer flagged this older version). ON
   * CONFLICT DO NOTHING on id keeps a re-pull idempotent. createdAt/
   * resolvedAt are normalized to ISO 8601 for the same reason
   * applyChatMessages normalizes sentAt — see that method's own comment.
   */
  private async applyRemarks(remarks: any[]): Promise<string | null> {
    let maxSeq: bigint | null = null;
    const touchedVersions = new Set<string>();
    for (const r of remarks) {
      await this.db.insert(schema.remarks).values({
        id: r.id,
        remarkSetId: r.remarkSetId,
        reportId: r.reportId,
        versionNo: r.versionNo,
        fieldName: r.fieldName,
        body: r.body,
        author: r.author,
        createdAt: new Date(r.createdAt).toISOString(),
        resolved: r.resolved,
        resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
      }).onConflictDoNothing();
      touchedVersions.add(`${r.reportId}::${r.versionNo}`);
      const seq = BigInt(r.seq);
      if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    }
    for (const key of touchedVersions) {
      const [reportId, versionNoStr] = key.split('::');
      await this.db
        .update(schema.reports)
        .set({ state: 'remarked' })
        .where(and(eq(schema.reports.reportId, reportId), eq(schema.reports.versionNo, Number(versionNoStr))));
    }
    return maxSeq === null ? null : maxSeq.toString();
  }

  /**
   * Invalidation notices' pull-down half — office is the only author
   * (cascade revalidation), pure apply. Mirrors vessel/store/inbox.go's
   * InsertInvalidationNotice + applyInvalidationNotice: stores the
   * append-only notice (ON CONFLICT DO NOTHING on seq keeps a re-pull
   * idempotent), then applies it to that exact reportId+versionNo's own
   * row — not necessarily the report's current latest version, since a
   * correction may have already moved on. Skips the transition (but
   * still records the notice) if that version no longer exists locally,
   * or is already invalidated with the identical broken-rules set.
   */
  private async applyInvalidationNotices(notices: any[]): Promise<string | null> {
    let maxSeq: bigint | null = null;
    for (const n of notices) {
      await this.db.insert(schema.invalidationNotices).values({
        seq: n.seq,
        reportId: n.reportId,
        versionNo: n.versionNo,
        brokenRules: n.brokenRules,
        computedAt: new Date(n.computedAt).toISOString(),
      }).onConflictDoNothing();

      const existing = (await this.db
        .select()
        .from(schema.reports)
        .where(and(eq(schema.reports.reportId, n.reportId), eq(schema.reports.versionNo, n.versionNo))))[0];
      if (existing) {
        const alreadySame = existing.state === 'invalidated'
          && JSON.stringify(existing.invalidatedRules) === JSON.stringify(n.brokenRules);
        if (!alreadySame) {
          const computedAt = new Date(n.computedAt).toISOString();
          await this.db
            .update(schema.reports)
            .set({
              state: 'invalidated',
              invalidatedFrom: existing.state === 'invalidated' ? existing.invalidatedFrom : existing.state,
              invalidatedRules: n.brokenRules,
              updatedAt: computedAt,
            })
            .where(and(eq(schema.reports.reportId, n.reportId), eq(schema.reports.versionNo, n.versionNo)));

          await this.db.insert(schema.reportEvents).values({
            reportId: n.reportId,
            versionNo: n.versionNo,
            type: 'invalidated',
            at: computedAt,
            detail: { brokenRules: n.brokenRules, fromState: existing.state === 'invalidated' ? existing.invalidatedFrom : existing.state },
          });
        }
      }

      const seq = BigInt(n.seq);
      if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    }
    return maxSeq === null ? null : maxSeq.toString();
  }

  private async pullConfiguration() {
    try {
      this.logger.log('Requesting downstream config sync from shore...');

      const vesselId = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'vessel_id')))[0]?.value;
      if (!vesselId) {
        this.logger.debug('Vessel not yet enrolled; skipping config pull.');
        return;
      }

      // Two-phase ack: this cycle acks whatever the *previous* cycle
      // applied (staged in configStore, since the ack has to travel in
      // the next request rather than the same round trip that produced
      // it), then processes whatever commands come back this time.
      const pendingAcksRow = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'pending_user_command_acks')))[0];
      const appliedUserCommandIds: string[] = pendingAcksRow ? JSON.parse(pendingAcksRow.value) : [];
      const users = await this.authService.listRosterSummary();
      const chatCursorRow = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'chat_seq_cursor')))[0];
      const lastChatSeq = chatCursorRow?.value;
      const remarkCursorRow = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'remark_seq_cursor')))[0];
      const lastRemarkSeq = remarkCursorRow?.value;
      const invalidationCursorRow = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'invalidation_seq_cursor')))[0];
      const lastInvalidationSeq = invalidationCursorRow?.value;
      const schemaCursorRow = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'schema_cursor')))[0];
      const lastSchemaCursor = schemaCursorRow?.value;
      // What this node is actually validating against, reported alongside
      // the cursor. The cursor says how far it has read; this says what it
      // ended up using, and the two diverge when a published document
      // failed to compile aboard. Office can only see that gap if the
      // vessel says so.
      const appliedSchemas = await this.reportAppliedSchemas();
      // What this node actually holds, read back from its own store. Office
      // cannot know it any other way: it previously recorded the bundle it
      // resolved and compared that against itself, so a vessel that
      // refused a bundle still read as up to date ashore.
      const appliedBundle = await this.readStoredBundle();

      // The vessel's own name and IMO travel with every check-in so shore
      // can record what this vessel calls itself. enroll only ever matched
      // on IMO and discarded the name, so without this office has no way to
      // know the two sides disagree.
      const identityRows = await this.db.select().from(schema.configStore);
      const identity: Record<string, string> = {};
      for (const row of identityRows) identity[row.key] = row.value;

      const response = await this.trpc.client.sync.pullConfig.query({
        vesselId,
        users,
        appliedUserCommandIds,
        lastChatSeq,
        lastRemarkSeq,
        lastInvalidationSeq,
        lastSchemaCursor,
        appliedSchemas,
        appliedBundle: appliedBundle?.bundleId
          ? { bundleId: appliedBundle.bundleId, versionNo: appliedBundle.versionNo ?? 0 }
          : null,
        vesselName: identity['vessel_name'] || undefined,
        imoNumber: identity['imo_number'] || undefined,
        runId: this.currentRunId || undefined,
      });

      // Remember shore's own answer so the vessel can display both names and
      // automatically resolve divergence by adopting the office's name/imo on sync.
      if (response.vessel) {
        for (const [key, value] of [
          ['office_vessel_name', response.vessel.name],
          ['office_imo_number', response.vessel.imo],
          ['vessel_name', response.vessel.name],
          ['imo_number', response.vessel.imo],
        ] as const) {
          if (!value) continue;
          await this.db
            .insert(schema.configStore)
            .values({ key, value, updatedAt: response.syncedAt })
            .onConflictDoUpdate({
              target: schema.configStore.key,
              set: { value, updatedAt: response.syncedAt },
            });
        }
        if (response.vessel.name && identity['vessel_name'] && response.vessel.name !== identity['vessel_name']) {
          this.logger.warn(
            `Vessel name disagreed with shore: local "${identity['vessel_name']}" vs office "${response.vessel.name}". Automatically updated to match office.`,
          );
        }
      }

      if (appliedUserCommandIds.length > 0) {
        await this.db.delete(schema.configStore).where(eq(schema.configStore.key, 'pending_user_command_acks'));
      }

      if (response.userCommands && response.userCommands.length > 0) {
        this.logger.log(`Received ${response.userCommands.length} pending user command(s) from shore.`);
        const newlyApplied = await this.applyUserCommands(response.userCommands);
        await this.db
          .insert(schema.configStore)
          .values({ key: 'pending_user_command_acks', value: JSON.stringify(newlyApplied), updatedAt: new Date().toISOString() })
          .onConflictDoUpdate({
            target: schema.configStore.key,
            set: { value: JSON.stringify(newlyApplied), updatedAt: new Date().toISOString() },
          });
      }

      if (response.chatMessages && response.chatMessages.length > 0) {
        this.logger.log(`Received ${response.chatMessages.length} chat message(s) from shore.`);
        const newMaxSeq = await this.applyChatMessages(response.chatMessages);
        if (newMaxSeq) {
          await this.db
            .insert(schema.configStore)
            .values({ key: 'chat_seq_cursor', value: newMaxSeq, updatedAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.configStore.key,
              set: { value: newMaxSeq, updatedAt: new Date().toISOString() },
            });
        }
      }

      if (response.remarks && response.remarks.length > 0) {
        this.logger.log(`Received ${response.remarks.length} remark(s) from shore.`);
        const newMaxSeq = await this.applyRemarks(response.remarks);
        if (newMaxSeq) {
          await this.db
            .insert(schema.configStore)
            .values({ key: 'remark_seq_cursor', value: newMaxSeq, updatedAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.configStore.key,
              set: { value: newMaxSeq, updatedAt: new Date().toISOString() },
            });
        }
      }

      if (response.invalidationNotices && response.invalidationNotices.length > 0) {
        this.logger.log(`Received ${response.invalidationNotices.length} invalidation notice(s) from shore.`);
        const newMaxSeq = await this.applyInvalidationNotices(response.invalidationNotices);
        if (newMaxSeq) {
          await this.db
            .insert(schema.configStore)
            .values({ key: 'invalidation_seq_cursor', value: newMaxSeq, updatedAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.configStore.key,
              set: { value: newMaxSeq, updatedAt: new Date().toISOString() },
            });
        }
      }

      if (response.schemaVersions && response.schemaVersions.length > 0) {
        this.logger.log(`Received ${response.schemaVersions.length} published schema version(s) from shore.`);
        const newCursor = await this.applySchemaVersions(response.schemaVersions);
        if (newCursor) {
          await this.db
            .insert(schema.configStore)
            .values({ key: 'schema_cursor', value: newCursor, updatedAt: new Date().toISOString() })
            .onConflictDoUpdate({
              target: schema.configStore.key,
              set: { value: newCursor, updatedAt: new Date().toISOString() },
            });
        }
      }

      if (response.bundle) {
        // Skip if we've already applied this exact bundle version (avoids redundant local writes every 30s).
        const current = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'config_bundle')))[0];
        const parsedCurrent = current ? JSON.parse(current.value) : undefined;
        const currentVersionNo = parsedCurrent?.versionNo;
        const currentBundleId = parsedCurrent?.bundleId;

        // Compare the bundle identity too, not just its version number.
        // versionNo comes from the bundle row's `cursor`, and two bundles
        // that ever resolve to the same number would otherwise leave the
        // vessel silently pinned to whichever it stored first.
        if (currentVersionNo !== response.bundle.versionNo || currentBundleId !== response.bundle.bundleId) {
          await this.db
            .insert(schema.configStore)
            .values({
              key: 'config_bundle',
              value: JSON.stringify(response.bundle),
              updatedAt: response.syncedAt,
            })
            .onConflictDoUpdate({
              target: schema.configStore.key,
              set: {
                value: JSON.stringify(response.bundle),
                updatedAt: response.syncedAt,
              },
            });
          this.logger.log(`Applied config bundle ${response.bundle.bundleId} (version ${response.bundle.versionNo}).`);
        }
      } else {
        // Shore answered, but resolved no bundle for this vessel — no
        // assignment covers it, at any scope. Previously this branch did
        // not exist and the vessel simply carried on with whatever (or
        // nothing) it already had, indistinguishable from a clean apply.
        this.lastConfigNotice =
          'Shore has no config bundle assigned to this vessel. Assign one in Office → Configuration → Assignments.';
        this.logger.warn(this.lastConfigNotice);
      }

      if (response.restoreCommands && response.restoreCommands.length > 0) {
        await this.applyRestoreCommands(vesselId, response.restoreCommands);
      }
    } catch (err: any) {
      this.lastConfigError = `Config pull failed: ${err.message}`;
      this.logger.error(`Failed to pull configuration: ${err.message}`);
    }
  }

  /**
   * Rebuilds this node from a bundle shore has queued for it
   * (architecture 12.5's DR push path) — ports the auto-fetch half of
   * ovl/vessel/httpapi's pullInboxBatch.
   *
   * Deliberately not part of the config-pull try block's own failure
   * handling: a restore that fails must not mark the whole config pull
   * as broken, because the rest of the cycle — user commands, chat,
   * remarks, the config bundle itself — already landed. Each command is
   * isolated for the same reason, so one bad bundle does not block the
   * next.
   *
   * Nothing is acked until the apply actually succeeds, so a fetch that
   * dies mid-write reappears on the next cycle and is retried; the apply
   * is built to be safely re-runnable precisely so that retry is free.
   */
  private async applyRestoreCommands(
    vesselId: string,
    commands: { id: string; reason: string; issuedAt: string }[],
  ): Promise<void> {
    this.logger.warn(`Shore has queued ${commands.length} restore bundle(s) for this vessel.`);
    for (const command of commands) {
      try {
        const fetched = await this.trpc.client.sync.fetchRestoreBundle.query({ vesselId, commandId: command.id });
        const result = await this.restoreBundleService.importCiphertext(fetched.ciphertextBase64);
        await this.trpc.client.sync.ackRestoreBundle.mutate({ vesselId, commandId: command.id });
        this.logger.log(
          `Restored from shore bundle ${command.id} ("${command.reason}"): ` +
            `${result.reports} report(s), ${result.versions} version(s), ${result.events} new event(s).`,
        );
      } catch (err: any) {
        // Left unacked on purpose — the next cycle tries again rather
        // than the restore silently disappearing. Logged loudly because
        // a vessel that keeps failing to restore is not something to
        // discover from a missing report weeks later.
        this.logger.error(`Restore bundle ${command.id} could not be applied: ${err.message}`);
      }
    }
  }

  /**
   * Stores schema documents the office has published and makes them live
   * — ports the schema half of ovl/office/syncservice's PullInbox.
   *
   * Applied before the config bundle in the same cycle, because a
   * bundle's field policies describe fields the schema defines; taking
   * them in the other order would briefly leave a policy pointing at
   * fields this node does not yet know about.
   *
   * The cursor only advances over rows actually written, so a document
   * that fails to store is offered again next cycle rather than being
   * skipped for good.
   */
  private async applySchemaVersions(
    versions: { schemaName: string; version: string; source: string; content: string; publishedAt: string; cursor: string }[],
  ): Promise<string | null> {
    const receivedAt = new Date().toISOString();
    let maxCursor: bigint | null = null;
    let stored = 0;

    for (const v of versions) {
      try {
        await this.db
          .insert(schema.schemaVersions)
          .values({
            schemaName: v.schemaName,
            version: v.version,
            source: v.source,
            content: v.content,
            publishedAt: v.publishedAt,
            receivedAt,
          })
          // Republishing the same name and version is office correcting a
          // document in place, so the newer content wins rather than the
          // insert being dropped.
          .onConflictDoUpdate({
            target: [schema.schemaVersions.schemaName, schema.schemaVersions.version],
            set: { content: v.content, source: v.source, publishedAt: v.publishedAt, receivedAt },
          });
        stored++;
        const c = BigInt(v.cursor);
        if (maxCursor === null || c > maxCursor) maxCursor = c;
      } catch (err: any) {
        this.logger.error(`Could not store schema ${v.schemaName}@${v.version}: ${err.message}`);
      }
    }

    if (stored > 0) {
      // Recompiled immediately so a new report form is usable this cycle
      // rather than after the next restart.
      await this.schemaRegistryService.loadSyncedSchemas();
    }
    return maxCursor === null ? null : maxCursor.toString();
  }

  /**
   * The newest version of each schema this node holds, for the check-in.
   *
   * Read back from the store rather than from the registry's in-memory
   * map so it reflects what was actually persisted — a document that was
   * received but rejected at compile time must not be reported as
   * applied, or office would see a ship as current when it is not.
   */
  private async reportAppliedSchemas(): Promise<{ schemaName: string; version: string; publishedAt: string }[]> {
    try {
      const rows = await this.db
        .select()
        .from(schema.schemaVersions)
        .orderBy(desc(schema.schemaVersions.publishedAt));
      const latest = new Map<string, { schemaName: string; version: string; publishedAt: string }>();
      for (const r of rows) {
        if (!latest.has(r.schemaName)) {
          latest.set(r.schemaName, { schemaName: r.schemaName, version: r.version, publishedAt: r.publishedAt });
        }
      }
      return Array.from(latest.values());
    } catch (err: any) {
      // Never worth failing a check-in over: the rest of the cycle —
      // pushing reports, pulling config — matters far more than this
      // report of what the node holds.
      this.logger.warn(`Could not read applied schemas for the check-in: ${err.message}`);
      return [];
    }
  }
}
