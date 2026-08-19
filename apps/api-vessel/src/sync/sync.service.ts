import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TrpcService } from '../rpc/trpc.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { isNull, eq } from 'drizzle-orm';
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
    
    return {
      enrolled,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError
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
   * ported from ovl/vessel/httpapi/usercommands.go's applyUserCommand,
   * called once per office-queued UserCommand returned by pullConfig.
   * Every command is acked back to office on the *next* check-in
   * regardless of outcome: a permanent failure (e.g. a role sent that
   * this vessel binary doesn't recognize) would otherwise retry forever
   * every 30s with no way to clear it, and a transient one (this vessel
   * momentarily missing the target user for a resetPassword/setActive,
   * because an earlier "create" command is still in flight) is rare
   * enough at this scale that logging it beats an infinite redelivery
   * loop for something an operator can just re-issue from office anyway.
   */
  private async applyUserCommands(commands: any[]): Promise<string[]> {
    const appliedIds: string[] = [];
    for (const cmd of commands) {
      try {
        await this.authService.applyUserCommand(cmd);
        this.logger.log(`Applied user command ${cmd.id} (${cmd.action} ${cmd.username}).`);
      } catch (err: any) {
        this.logger.error(`Failed to apply user command ${cmd.id} (${cmd.action} ${cmd.username}): ${err.message}`);
      }
      appliedIds.push(cmd.id);
    }
    return appliedIds;
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

      const response = await this.trpc.client.sync.pullConfig.query({ vesselId, users, appliedUserCommandIds });

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
