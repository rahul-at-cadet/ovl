import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../database/database.module';
import { ConfigBundleService } from '../config/config-bundle/config-bundle.service';
import { encrypt } from './logic/backup-crypto';
import { toIso, toIsoOrNull } from '../common/iso-time';
import {
  RESTORE_BUNDLE_VERSION,
  type RestoreBundle,
  type RestoreBundleChatMessage,
  type RestoreBundleEvent,
  type RestoreBundleReport,
  type RestoreBundleReportVersion,
} from './logic/restore-bundle';

/**
 * Builds and encrypts a vessel's disaster-recovery bundle — ports
 * ovl/office/restorebundle.BuildBundle.
 *
 * Two call sites need this and neither owns the other, which is why it
 * is a service rather than a private method on the router: the admin
 * "download the file" action, and the vessel's own authenticated fetch
 * after it sees a queued restore command on sync.
 *
 * Every call rebuilds from current state rather than caching bytes when
 * the command was queued. A restore bundle is meant to be "everything
 * shore holds as of now", and a vessel that only calls in once a day
 * would otherwise restore to whenever an admin happened to click push.
 */
@Injectable()
export class RestoreBundleService {
  private readonly logger = new Logger(RestoreBundleService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly configBundleService: ConfigBundleService,
  ) {}

  /**
   * The vessel's DR recipient key, or null if it has none.
   *
   * A vessel enrolled before the DR keypair exchange existed, or one
   * whose enrollment was revoked and not yet re-redeemed, genuinely has
   * no key — encrypting to nothing would produce a bundle nobody could
   * ever open, so callers turn this into "re-enrol this vessel first"
   * rather than failing obscurely inside the crypto layer.
   */
  async drPublicKey(vesselId: string): Promise<string | null> {
    const row = (
      await this.db
        .select({ drPublicKey: schema.enrollments.drPublicKey })
        .from(schema.enrollments)
        .where(eq(schema.enrollments.vesselId, vesselId))
        .limit(1)
    )[0];
    return row?.drPublicKey || null;
  }

  /**
   * Assembles every version of every report shore holds for this vessel,
   * plus its audit trail, chat and resolved config bundle.
   *
   * Attachments are deliberately excluded — see the wire type's own note.
   */
  async build(vesselId: string): Promise<RestoreBundle> {
    const vessel = (
      await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, vesselId)).limit(1)
    )[0];
    if (!vessel) throw new Error(`Vessel ${vesselId} not found`);

    // Three whole-vessel reads grouped in memory rather than one query
    // per report. The per-report shape is what the Go original does
    // because its store exposes per-report accessors; issuing 3N queries
    // here for a vessel with a year of reporting would be needlessly
    // slow when the same rows come back in three.
    const [versionRows, eventRows, chatRows] = await Promise.all([
      this.db
        .select()
        .from(schema.reportVersions)
        .where(eq(schema.reportVersions.vesselId, vesselId))
        .orderBy(asc(schema.reportVersions.reportId), asc(schema.reportVersions.versionNo)),
      this.db
        .select()
        .from(schema.reportAuditEvents)
        .where(eq(schema.reportAuditEvents.vesselId, vesselId))
        .orderBy(asc(schema.reportAuditEvents.occurredAt), asc(schema.reportAuditEvents.id)),
      this.db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.vesselId, vesselId))
        .orderBy(asc(schema.chatMessages.seq)),
    ]);

    const byReport = new Map<string, RestoreBundleReport>();
    const reportFor = (reportId: string): RestoreBundleReport => {
      let entry = byReport.get(reportId);
      if (!entry) {
        entry = { reportId, versions: [], events: [], chat: [] };
        byReport.set(reportId, entry);
      }
      return entry;
    };

    for (const r of versionRows) {
      const version: RestoreBundleReportVersion = {
        reportId: r.reportId,
        versionNo: r.versionNo,
        // Stored as the vessel's own schema id, ".json" and all, so it
        // travels back unchanged — see the sync router's own note.
        schemaKind: r.schemaKind,
        schemaVersion: r.schemaVersion,
        eventType: r.eventType,
        state: r.state,
        eventTime: toIso(r.eventTime),
        fields: (r.fields as Record<string, unknown>) ?? {},
        submittedAt: toIsoOrNull(r.submittedAt),
        receivedAt: toIso(r.receivedAt),
      };
      reportFor(r.reportId).versions.push(version);
    }

    for (const e of eventRows) {
      const event: RestoreBundleEvent = {
        reportId: e.reportId,
        versionNo: e.versionNo,
        type: e.eventType,
        actor: e.actor,
        at: toIso(e.occurredAt),
        detail: (e.detail as Record<string, unknown>) ?? {},
      };
      // An event whose report has no versions on file still belongs in
      // the bundle: dropping it would quietly shorten the audit trail,
      // which is the one thing a restored vessel cannot reconstruct.
      reportFor(e.reportId).events.push(event);
    }

    for (const m of chatRows) {
      const message: RestoreBundleChatMessage = {
        id: m.id,
        reportId: m.reportId,
        sender: m.sender,
        body: m.body,
        sentAt: toIso(m.sentAt),
        // Same translation the sync boundary already performs: office
        // stores 'office'/'vessel', the vessel's local schema and UI use
        // 'shore_to_ship'/'ship_to_shore'.
        direction: m.direction === 'office' ? 'shore_to_ship' : 'ship_to_shore',
      };
      reportFor(m.reportId).chat.push(message);
    }

    // Unconditional, unlike the sync pull: a restore bundle is a
    // point-in-time full snapshot, so there is no "only if newer than
    // the vessel's cursor" gate. Null when no assignment covers the
    // vessel at any scope — a reachable state, not an error.
    const wire = await this.configBundleService.resolveForVessel(vesselId);

    return {
      wireVersion: RESTORE_BUNDLE_VERSION,
      vesselId: vessel.id,
      vesselName: vessel.name,
      vesselImo: vessel.imo,
      generatedAt: new Date().toISOString(),
      reports: Array.from(byReport.values()).sort((a, b) => a.reportId.localeCompare(b.reportId)),
      configBundle: wire
        ? {
            bundleId: wire.bundleId,
            versionNo: wire.versionNo,
            content: wire,
            publishedAt: toIso(wire.publishedAt),
          }
        : null,
    };
  }

  /**
   * Builds, JSON-encodes and encrypts to the vessel's DR key.
   *
   * Base64 rather than raw bytes because both delivery paths are tRPC
   * over JSON. The ciphertext is already an opaque age file; base64 is
   * only the transport encoding, and the vessel decodes it straight back
   * before decrypting.
   */
  async buildEncrypted(vesselId: string): Promise<{
    bundle: RestoreBundle;
    ciphertextBase64: string;
    reportCount: number;
    versionCount: number;
  }> {
    const drPublicKey = await this.drPublicKey(vesselId);
    if (!drPublicKey) {
      throw new Error(
        'This vessel has no restore key on file yet — it must redeem (or re-redeem) an enrollment code before a restore bundle can be generated for it.',
      );
    }
    const bundle = await this.build(vesselId);
    const ciphertext = await encrypt(new TextEncoder().encode(JSON.stringify(bundle)), drPublicKey);
    const versionCount = bundle.reports.reduce((n, r) => n + r.versions.length, 0);
    this.logger.log(
      `Built restore bundle for vessel ${vesselId}: ${bundle.reports.length} report(s), ${versionCount} version(s), ${ciphertext.length} encrypted bytes.`,
    );
    return {
      bundle,
      ciphertextBase64: Buffer.from(ciphertext).toString('base64'),
      reportCount: bundle.reports.length,
      versionCount,
    };
  }

  /** Restore commands queued for one vessel, newest first. */
  async listCommands(vesselId: string) {
    return this.db
      .select({
        id: schema.restoreCommands.id,
        reason: schema.restoreCommands.reason,
        issuedBy: schema.restoreCommands.issuedBy,
        issuedAt: schema.restoreCommands.issuedAt,
        fetchedAt: schema.restoreCommands.fetchedAt,
        appliedAt: schema.restoreCommands.appliedAt,
      })
      .from(schema.restoreCommands)
      .where(eq(schema.restoreCommands.vesselId, vesselId))
      .orderBy(schema.restoreCommands.seq);
  }

  /**
   * Commands the vessel has not finished applying, oldest first.
   *
   * Keyed on appliedAt rather than fetchedAt so a fetch that succeeded
   * but whose apply then failed is retried on the next cycle instead of
   * being lost — the vessel is the only side that knows whether the
   * bundle actually landed.
   */
  async pendingCommands(vesselId: string) {
    const rows = await this.db
      .select({ id: schema.restoreCommands.id, reason: schema.restoreCommands.reason, issuedAt: schema.restoreCommands.issuedAt })
      .from(schema.restoreCommands)
      .where(and(eq(schema.restoreCommands.vesselId, vesselId), isNull(schema.restoreCommands.appliedAt)))
      .orderBy(schema.restoreCommands.seq);
    return rows;
  }
}
