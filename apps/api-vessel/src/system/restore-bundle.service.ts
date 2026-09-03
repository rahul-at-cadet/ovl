import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { DATABASE_CONNECTION } from '../database/database.module';
import { decrypt, generateIdentity, type DrIdentity } from './backup-crypto';
import { decodeRestoreBundle, type RestoreBundle } from './restore-bundle';

/** config_store keys this vessel's DR keypair lives under. */
const DR_PRIVATE_KEY = 'dr_private_key';
const DR_PUBLIC_KEY = 'dr_public_key';

export interface RestoreImportResult {
  vesselName: string;
  generatedAt: string;
  reports: number;
  versions: number;
  events: number;
  chatMessages: number;
  configBundleApplied: boolean;
}

/**
 * This vessel's disaster-recovery keypair and bundle import — ports
 * ovl/vessel/httpapi/backup.go's restore-bundle half.
 *
 * The private key is minted here and never leaves; only the public half
 * travels to shore at enrollment, so office can build a bundle for this
 * vessel that office itself cannot read. Losing this node's data means
 * losing that private key too, which is why re-enrolment mints a fresh
 * pair and office replaces the one it holds — a bundle encrypted to the
 * old key would be unopenable by the very node it was meant to rescue.
 */
@Injectable()
export class RestoreBundleService {
  private readonly logger = new Logger(RestoreBundleService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: any,
  ) {}

  private async readConfig(key: string): Promise<string | undefined> {
    const row = (await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, key)).limit(1))[0];
    return row?.value;
  }

  private async writeConfig(key: string, value: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.db
      .insert(schema.configStore)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: schema.configStore.key, set: { value, updatedAt } });
  }

  /**
   * Mints a fresh keypair and stores it, returning the public half to
   * send to shore.
   *
   * Always a new pair, never reused: this is called at enrollment
   * redemption, and a node that is re-enrolling has usually just been
   * rebuilt. Keeping an old key here while office recorded a new one —
   * or the reverse — is precisely the mismatch that makes a restore
   * bundle unopenable, so both sides are re-keyed by the one action.
   */
  async rotateIdentity(): Promise<string> {
    const identity = await generateIdentity();
    await this.writeConfig(DR_PRIVATE_KEY, identity.privateKey);
    await this.writeConfig(DR_PUBLIC_KEY, identity.publicKey);
    this.logger.log('Minted a new disaster-recovery keypair for this vessel.');
    return identity.publicKey;
  }

  /** The stored keypair, or null on a node that has never enrolled. */
  async identity(): Promise<DrIdentity | null> {
    const privateKey = await this.readConfig(DR_PRIVATE_KEY);
    const publicKey = await this.readConfig(DR_PUBLIC_KEY);
    if (!privateKey || !publicKey) return null;
    return { privateKey, publicKey };
  }

  /**
   * Decrypts, version-checks and applies a bundle office produced.
   *
   * Shared by the manual import (a Master uploads a file carried
   * aboard) and the sync path (the vessel fetches it itself after
   * seeing a queued restore command) — same bytes and same key, two
   * ways of arriving here.
   */
  async importCiphertext(ciphertextBase64: string): Promise<RestoreImportResult> {
    const identity = await this.identity();
    if (!identity) {
      throw new Error(
        'This node has no restore key — it must complete enrollment before a restore bundle can be imported.',
      );
    }

    let plaintext: Uint8Array;
    try {
      plaintext = await decrypt(Buffer.from(ciphertextBase64, 'base64'), identity.privateKey);
    } catch (e: any) {
      // Authenticated encryption, so this covers a corrupted file as
      // well as one meant for a different (or previous) key — both are
      // "not for this node", which is what the operator needs to know.
      throw new Error(
        `Could not decrypt this restore bundle — it may have been encrypted for a different vessel, or before this node was last re-enrolled (${e.message}).`,
      );
    }

    const bundle = decodeRestoreBundle(new TextDecoder().decode(plaintext));
    return this.apply(bundle);
  }

  /**
   * Writes a decoded bundle into the local store.
   *
   * Built to be safely re-runnable, unlike the Go original, which
   * documents that a second import duplicates the audit trail because
   * its event insert has no dedup key. There is a natural one here —
   * a report's version, event type and timestamp — so a retried import
   * (a sync that fetched successfully but died mid-apply, then came
   * back next cycle) rebuilds the same trail instead of doubling it.
   *
   * Reports themselves upsert by (reportId, versionNo): submitted
   * reports are immutable, so re-applying the same bundle writes the
   * same values. The one thing this can overwrite is a local draft
   * sitting at the same version, which is why both entry points make
   * the operator confirm first.
   */
  private async apply(bundle: RestoreBundle): Promise<RestoreImportResult> {
    const result: RestoreImportResult = {
      vesselName: bundle.vesselName,
      generatedAt: bundle.generatedAt,
      reports: 0,
      versions: 0,
      events: 0,
      chatMessages: 0,
      configBundleApplied: false,
    };

    for (const report of bundle.reports) {
      result.reports++;

      // Office does not store who submitted a report on the version row
      // itself — the name lives on the 'submitted' audit event's actor.
      // Recovering it here keeps the restored report attributed instead
      // of blank, which matters because the vessel's own UI shows it.
      const submitterFor = new Map<number, string>();
      for (const event of report.events) {
        if (event.type === 'submitted' && event.actor) submitterFor.set(event.versionNo, event.actor);
      }

      for (const version of report.versions) {
        const submittedBy = submitterFor.get(version.versionNo) ?? '';
        const row = {
          reportId: version.reportId,
          versionNo: version.versionNo,
          schemaName: version.schemaKind,
          eventType: version.eventType,
          eventTime: version.eventTime,
          fields: version.fields,
          state: version.state,
          invalidatedFrom: '',
          invalidatedRules: [],
          // The vessel's own created/updated timestamps did not survive
          // the trip to shore, so they are reconstructed from what did.
          // Better a coherent restored history than an invented one.
          createdAt: version.submittedAt ?? version.receivedAt,
          createdBy: submittedBy,
          updatedAt: version.receivedAt,
          submittedAt: version.submittedAt,
          submittedBy,
        };
        await this.db
          .insert(schema.reports)
          .values(row)
          .onConflictDoUpdate({ target: [schema.reports.reportId, schema.reports.versionNo], set: row });
        result.versions++;
      }

      for (const event of report.events) {
        const existing = await this.db
          .select({ id: schema.reportEvents.id })
          .from(schema.reportEvents)
          .where(
            and(
              eq(schema.reportEvents.reportId, event.reportId),
              eq(schema.reportEvents.versionNo, event.versionNo),
              eq(schema.reportEvents.type, event.type),
              eq(schema.reportEvents.at, event.at),
            ),
          )
          .limit(1);
        if (existing.length > 0) continue;
        await this.db.insert(schema.reportEvents).values({
          reportId: event.reportId,
          versionNo: event.versionNo,
          type: event.type,
          at: event.at,
          actor: event.actor,
          detail: event.detail,
        });
        result.events++;
      }

      for (const message of report.chat) {
        await this.db
          .insert(schema.chatMessages)
          .values({
            id: message.id,
            reportId: message.reportId,
            sender: message.sender,
            body: message.body,
            sentAt: message.sentAt,
            direction: message.direction,
          })
          .onConflictDoNothing();
        result.chatMessages++;
      }
    }

    if (bundle.configBundle) {
      // Stored exactly as an ordinary sync pull would store it, under
      // the same key and in the same shape, so a restored node reads its
      // config through the identical config-wire path — see
      // SyncService.pullConfiguration.
      await this.writeConfig('config_bundle', JSON.stringify(bundle.configBundle.content));
      result.configBundleApplied = true;
    }

    this.logger.log(
      `Applied restore bundle generated ${bundle.generatedAt}: ${result.reports} report(s), ${result.versions} version(s), ${result.events} new event(s), ${result.chatMessages} chat message(s).`,
    );
    return result;
  }
}
