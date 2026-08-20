import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TrpcService } from '../rpc/trpc.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { isNull, eq, and } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private isSyncing = false;
  private lastSuccess: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly trpc: TrpcService,
    private readonly authService: AuthService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: any, // type as NodePgDatabase/BetterSQLite3Database if configured
  ) {}

  /**
   * The Sync Engine Loop
   * Runs every 30 seconds to push local changes to shore and pull new configs from shore.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      this.logger.debug('Starting Sync Cycle...');

      // 1. Upstream Sync (Ship -> Shore)
      await this.pushOutboxEvents();

      // 2. Downstream Sync (Shore -> Ship)
      await this.pullConfiguration();

      this.logger.debug('Sync Cycle Complete');
      this.lastSuccess = new Date().toISOString();
      this.lastError = null;
    } catch (error: any) {
      this.logger.error(`Sync cycle failed: ${error.message}`);
      this.lastError = error.message;
    } finally {
      this.isSyncing = false;
    }
  }

  async getStatus() {
    const result = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'vessel_id'));
    const enrolled = result.length > 0;

    // Real outbox depth, not a placeholder: the same isNull(processedAt)
    // filter pushOutboxEvents itself uses to find what still needs
    // pushing to shore.
    const pending = await this.db
      .select()
      .from(schema.syncOutbox)
      .where(isNull(schema.syncOutbox.processedAt));

    return {
      enrolled,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      pendingCount: pending.length,
    };
  }

  async syncNow() {
    await this.handleCron();
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
        this.logger.log(
          `Successfully pushed ${response.processedCount} events. Marking locally as processed.`,
        );

        // 2. Mark as processed locally so they aren't sent again
        const now = new Date().toISOString();
        for (const event of pendingEvents) {
          await this.db
            .update(schema.syncOutbox)
            .set({ processedAt: now })
            .where(eq(schema.syncOutbox.id, event.id));
        }
      }
    } catch (err: any) {
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

      const response = await this.trpc.client.sync.pullConfig.query({ vesselId, users, appliedUserCommandIds, lastChatSeq, lastRemarkSeq, lastInvalidationSeq });

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

      if (response.bundle) {
        // Skip if we've already applied this exact bundle version (avoids redundant local writes every 30s).
        const current = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'config_bundle')))[0];
        const currentVersionNo = current ? JSON.parse(current.value)?.versionNo : undefined;

        if (currentVersionNo !== response.bundle.versionNo) {
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
      }
    } catch (err: any) {
      this.logger.error(`Failed to pull configuration: ${err.message}`);
    }
  }
}
