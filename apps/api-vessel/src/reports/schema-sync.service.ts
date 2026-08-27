import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { formSchemaChecksum } from '@ovl/vessel-database';
import { DATABASE_CONNECTION } from '../database/database.module';

/** One schema the office says this vessel should hold. */
export interface IncomingSchema {
  schemaName: string;
  version: string;
  checksum: string;
  /** The schema document, as a JSON string. */
  content: string;
}

export interface SchemaSyncPayload {
  changed: IncomingSchema[];
  removed: string[];
  syncedAt?: string;
}

export interface SchemaSyncResult {
  applied: string[];
  removed: string[];
  /** Items the vessel refused, with why. Never partially applied. */
  rejected: Array<{ schemaName: string; reason: string }>;
}

export class SchemaSyncRejected extends Error {
  constructor(
    message: string,
    readonly rejected: Array<{ schemaName: string; reason: string }>,
  ) {
    super(message);
    this.name = 'SchemaSyncRejected';
  }
}

/**
 * Applies a schema sync from the office to the vessel's local store.
 *
 * Written around one question: what is true if this dies half way through?
 *
 * **Validate everything, then write once.** The whole payload is checked before
 * a single row is touched, and applied inside one SQLite transaction. A crash,
 * a killed process, or a rejected item leaves the vessel on exactly the schema
 * set it had before — never a mixture where some forms are new, some are old,
 * and one has been deleted.
 *
 * **The protocol carries no resume state.** The vessel derives what it knows
 * from its own table on every check-in, so a failed sync needs no recovery: the
 * next one simply asks again and gets the same diff. That is deliberately
 * unlike the seq-cursor streams (chat, remarks, invalidations), where a lost
 * ack can strand a cursor — there is no cursor here to corrupt.
 *
 * **Checksums are verified, not trusted.** The office sends a hash and the
 * vessel recomputes it from the content it actually received, so a truncated
 * or corrupted body is rejected rather than stored and rendered as a broken
 * form. This is the check that turns a bad link into a failed sync instead of a
 * silently wrong one.
 */
@Injectable()
export class SchemaSyncService {
  private readonly logger = new Logger(SchemaSyncService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: any,
  ) {}

  /** What this vessel currently holds, for the office to diff against. */
  async known(): Promise<Array<{ schemaName: string; checksum: string }>> {
    const rows = await this.db
      .select({ schemaName: schema.formSchemas.schemaName, checksum: schema.formSchemas.checksum })
      .from(schema.formSchemas);
    return rows;
  }

  /**
   * Applies a payload, or applies none of it.
   *
   * All-or-nothing across the whole batch, not per item. The office computes
   * the diff as one coherent set, so applying half of it leaves the vessel in a
   * state that corresponds to no office state at all — and the dangerous case
   * is concrete: a payload that un-adopts A and adopts B, where B arrives
   * corrupt, would delete A and fail to install B, leaving the vessel with
   * neither form.
   *
   * A rejected batch is not a problem to recover from. The protocol carries no
   * cursor, so the next check-in asks again and gets the same diff.
   */
  async apply(payload: SchemaSyncPayload): Promise<SchemaSyncResult> {
    const rejected: Array<{ schemaName: string; reason: string }> = [];
    const accepted: Array<IncomingSchema & { parsed: unknown }> = [];
    const seen = new Set<string>();

    for (const item of payload.changed ?? []) {
      const reason = this.reject(item, seen);
      if (reason) {
        rejected.push({ schemaName: item?.schemaName ?? '(unnamed)', reason });
        continue;
      }
      seen.add(item.schemaName);
      accepted.push({ ...item, parsed: JSON.parse(item.content) });
    }

    const removed = (payload.removed ?? []).filter(
      (name) => typeof name === 'string' && name.length > 0,
    );

    // One bad item voids the batch. See the note above on why applying the
    // good half is worse than applying nothing.
    if (rejected.length > 0) {
      this.logger.error(
        `Refusing the whole schema sync: ` +
          rejected.map((r) => `${r.schemaName} (${r.reason})`).join(', '),
      );
      return { applied: [], removed: [], rejected };
    }

    // Nothing to do — and importantly, no empty transaction that would still
    // rewrite rows and bump their synced_at for no reason.
    if (accepted.length === 0 && removed.length === 0) {
      return { applied: [], removed: [], rejected };
    }

    // One transaction for the whole batch. better-sqlite3 is synchronous, so
    // this either commits entirely or rolls back entirely — there is no window
    // in which the vessel holds half of a schema set.
    // Drizzle's better-sqlite3 transaction() runs the callback immediately and
    // returns its value — unlike better-sqlite3's own transaction(), which
    // returns a function you then call. Getting that wrong means the body
    // never runs and the sync silently applies nothing.
    this.db.transaction((tx: any) => {
      if (removed.length > 0) {
        tx.delete(schema.formSchemas)
          .where(inArray(schema.formSchemas.schemaName, removed))
          .run();
      }

      for (const item of accepted) {
        tx.insert(schema.formSchemas)
          .values({
            schemaName: item.schemaName,
            version: item.version,
            checksum: item.checksum,
            content: item.content,
            syncedAt: payload.syncedAt ?? new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: schema.formSchemas.schemaName,
            set: {
              version: item.version,
              checksum: item.checksum,
              content: item.content,
              syncedAt: payload.syncedAt ?? new Date().toISOString(),
            },
          })
          .run();
      }
    });

    return { applied: accepted.map((a) => a.schemaName), removed, rejected };
  }

  /** Everything the vessel holds, parsed. */
  async list(): Promise<Array<{ schemaName: string; version: string; document: unknown }>> {
    const rows = await this.db.select().from(schema.formSchemas);
    return rows.map((row: any) => ({
      schemaName: row.schemaName,
      version: row.version,
      document: JSON.parse(row.content),
    }));
  }

  /**
   * Why this item cannot be stored, or null.
   *
   * Every check here is about not storing something that would later render as
   * a broken or wrong form. A schema that fails validation is worse than a
   * missing one, because the missing one is obvious.
   */
  private reject(item: IncomingSchema | undefined, seen: Set<string>): string | null {
    if (!item || typeof item !== 'object') return 'not an object';
    if (typeof item.schemaName !== 'string' || item.schemaName.length === 0) {
      return 'missing schemaName';
    }
    if (typeof item.version !== 'string' || item.version.length === 0) return 'missing version';
    if (typeof item.content !== 'string' || item.content.length === 0) return 'missing content';

    // A payload naming the same schema twice has no single correct outcome —
    // last-write-wins would silently pick one. Refuse both rather than guess.
    if (seen.has(item.schemaName)) return 'duplicate schemaName in payload';

    let parsed: unknown;
    try {
      parsed = JSON.parse(item.content);
    } catch (error) {
      return `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'document is not an object';
    }
    if (!Array.isArray((parsed as { fields?: unknown }).fields)) {
      return 'document has no fields array';
    }

    // Recomputed from what actually arrived, not taken on trust. A truncated
    // body over a bad satellite link fails here instead of being stored and
    // rendered as a form missing half its fields.
    if (typeof item.checksum !== 'string' || item.checksum.length === 0) return 'missing checksum';
    const actual = formSchemaChecksum(parsed);
    if (actual !== item.checksum) {
      return `checksum mismatch (expected ${item.checksum}, computed ${actual})`;
    }

    return null;
  }
}
