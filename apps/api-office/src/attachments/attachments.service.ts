import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../database/database.module';
import { AttachmentStore } from './attachment-store';
import { toIso } from '../common/iso-time';

/**
 * Shore-side attachment ingest — ports ovl/office/syncservice/attachments.go.
 *
 * Three tables for this have existed since the first migration with no
 * code behind them: vessels captured attachments locally and nothing ever
 * carried them ashore, so a Bunker or EDN report's supporting evidence
 * simply never left the ship. attachments.synced_at on the vessel stayed
 * permanently null for the same reason.
 *
 * Transferred in chunks rather than whole because the link is satellite:
 * an interrupted 8 MB photo has to resume, not restart. The vessel asks
 * which chunks are missing, sends those, and office assembles, verifies
 * the sha256 and promotes the result into the content-addressed store.
 */

/** A sha256 digest as the wire carries it. Anything else is refused. */
const CONTENT_HASH = /^[0-9a-f]{64}$/;

/**
 * Ceiling on one chunk. The transport is JSON, so a chunk arrives
 * base64-encoded at about 4/3 its size; 1 MiB keeps a single request
 * comfortably small on a link where a large body is likely to be cut off
 * part way.
 */
export const MAX_CHUNK_BYTES = 1024 * 1024;

/**
 * Ceiling on one attachment. Deliberately generous — this is evidence
 * photography, not video — but present, so a malformed or hostile
 * declaration cannot make office reserve an unbounded number of chunk
 * slots before a single byte arrives.
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export interface AttachmentMeta {
  reportId: string;
  versionNo: number;
  fieldName: string;
  filename: string;
  contentType: string;
  contentHash: string;
  totalSize: number;
  chunkSize: number;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly store: AttachmentStore;
  private readonly stagingDir: string;

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {
    const baseDir = process.env.ATTACHMENTS_DIR || path.join(process.cwd(), 'attachments');
    this.store = new AttachmentStore(path.join(baseDir, 'objects'));
    // Partial uploads are kept apart from the store itself: only content
    // whose hash has been verified is ever allowed into `objects`.
    this.stagingDir = path.join(baseDir, 'staging');
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  /** How many chunks of chunkSize cover totalSize bytes. */
  private chunkCount(totalSize: number, chunkSize: number): number {
    if (chunkSize <= 0) return 0;
    return Math.ceil(totalSize / chunkSize);
  }

  private chunkPath(hash: string, index: number): string {
    return path.join(this.stagingDir, hash, `${index}`);
  }

  private assertHash(hash: string): void {
    if (!CONTENT_HASH.test(hash)) {
      throw new Error('content hash must be a 64-character lowercase hex sha256 digest');
    }
  }

  /**
   * Records which report an attachment belongs to, and answers which
   * chunks office still needs.
   *
   * This is the only call carrying the full report context — a chunk
   * upload has nothing but a bare content hash — so the association is
   * written here whether or not the content itself turns out to be
   * already held. Two reports citing the same photo both get their row;
   * the bytes are stored once.
   */
  async queryMissingChunks(
    vesselId: string,
    meta: AttachmentMeta,
  ): Promise<{ alreadyComplete: boolean; missingChunkIndices: number[] }> {
    this.assertHash(meta.contentHash);
    if (!Number.isInteger(meta.totalSize) || meta.totalSize < 0 || meta.totalSize > MAX_ATTACHMENT_BYTES) {
      throw new Error(`totalSize must be between 0 and ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    if (!Number.isInteger(meta.chunkSize) || meta.chunkSize <= 0 || meta.chunkSize > MAX_CHUNK_BYTES) {
      throw new Error(`chunkSize must be between 1 and ${MAX_CHUNK_BYTES} bytes`);
    }

    await this.upsertReportAttachment(vesselId, meta);

    // Content addressing is global, so an identical file another vessel
    // already sent needs no transfer at all.
    if (this.store.has(meta.contentHash)) {
      return { alreadyComplete: true, missingChunkIndices: [] };
    }

    const [upload] = await this.db
      .insert(schema.attachmentUploads)
      .values({
        contentHash: meta.contentHash,
        totalSize: meta.totalSize,
        chunkSize: meta.chunkSize,
        contentType: meta.contentType,
        startedAt: new Date().toISOString(),
      })
      // The declared size and chunking are fixed by whoever started the
      // upload. Letting a later call change them would renumber chunks
      // that have already arrived, so a resumed transfer keeps the
      // original terms.
      .onConflictDoUpdate({
        target: schema.attachmentUploads.contentHash,
        set: { contentType: meta.contentType },
      })
      .returning();

    return { alreadyComplete: false, missingChunkIndices: await this.missingChunkIndices(upload) };
  }

  private async missingChunkIndices(upload: {
    contentHash: string;
    totalSize: number;
    chunkSize: number;
  }): Promise<number[]> {
    const received = await this.db
      .select({ chunkIndex: schema.attachmentUploadChunks.chunkIndex })
      .from(schema.attachmentUploadChunks)
      .where(eq(schema.attachmentUploadChunks.contentHash, upload.contentHash));
    const have = new Set(received.map((r) => r.chunkIndex));

    const total = this.chunkCount(upload.totalSize, upload.chunkSize);
    const missing: number[] = [];
    for (let i = 0; i < total; i++) if (!have.has(i)) missing.push(i);
    return missing;
  }

  /**
   * Stages one chunk and, once the set is complete, assembles, verifies
   * and promotes it.
   */
  async uploadChunk(
    hash: string,
    chunkIndex: number,
    data: Buffer,
  ): Promise<{ complete: boolean; missingChunkIndices: number[] }> {
    this.assertHash(hash);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('chunkIndex must be a non-negative integer');
    if (data.length > MAX_CHUNK_BYTES) throw new Error(`chunk exceeds ${MAX_CHUNK_BYTES} bytes`);

    if (this.store.has(hash)) return { complete: true, missingChunkIndices: [] };

    const [upload] = await this.db
      .select()
      .from(schema.attachmentUploads)
      .where(eq(schema.attachmentUploads.contentHash, hash))
      .limit(1);
    if (!upload) {
      // Without the declared size and chunking there is no way to know
      // how many chunks to expect, so nothing can be assembled.
      throw new Error('query the missing chunks for this attachment before uploading any');
    }

    const total = this.chunkCount(upload.totalSize, upload.chunkSize);
    if (chunkIndex >= total) {
      throw new Error(`chunkIndex ${chunkIndex} is beyond the ${total} chunks this attachment declares`);
    }

    const target = this.chunkPath(hash, chunkIndex);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written and renamed so a chunk recorded as received is always a
    // whole chunk — a truncated one would corrupt the assembly and only
    // surface as a hash mismatch at the very end.
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);

    await this.db
      .insert(schema.attachmentUploadChunks)
      .values({ contentHash: hash, chunkIndex, receivedAt: new Date().toISOString() })
      .onConflictDoNothing();

    const missing = await this.missingChunkIndices(upload);
    if (missing.length > 0) return { complete: false, missingChunkIndices: missing };

    await this.assembleAndPromote(upload);
    return { complete: true, missingChunkIndices: [] };
  }

  /**
   * Concatenates the staged chunks in index order, hands the result to
   * the store for hash verification, and clears staging either way.
   *
   * On failure staging is cleared deliberately rather than kept: a
   * mismatch means these chunks already produced bad output once, so the
   * next query has to start the transfer over instead of being told to
   * resume from them.
   */
  private async assembleAndPromote(upload: {
    contentHash: string;
    totalSize: number;
    chunkSize: number;
  }): Promise<void> {
    const total = this.chunkCount(upload.totalSize, upload.chunkSize);
    const assembled = path.join(this.stagingDir, `${upload.contentHash}.assembling`);

    try {
      const out = fs.openSync(assembled, 'w');
      try {
        for (let i = 0; i < total; i++) {
          // Streamed chunk by chunk: an attachment must never be held
          // whole in memory on a shared shore process.
          fs.writeSync(out, fs.readFileSync(this.chunkPath(upload.contentHash, i)));
        }
      } finally {
        fs.closeSync(out);
      }
      this.store.putFile(assembled, upload.contentHash);
      this.logger.log(`Attachment ${upload.contentHash.slice(0, 12)}… assembled from ${total} chunk(s).`);
    } catch (err: any) {
      fs.rmSync(assembled, { force: true });
      await this.clearStaging(upload.contentHash);
      this.logger.error(`Attachment ${upload.contentHash.slice(0, 12)}… failed to assemble: ${err.message}`);
      throw err;
    }
    await this.clearStaging(upload.contentHash);
  }

  private async clearStaging(hash: string): Promise<void> {
    fs.rmSync(path.join(this.stagingDir, hash), { recursive: true, force: true });
    // The chunk rows go with the files. Leaving them would tell the next
    // query that chunks are held when their bytes are gone.
    await this.db.delete(schema.attachmentUploadChunks).where(eq(schema.attachmentUploadChunks.contentHash, hash));
    await this.db.delete(schema.attachmentUploads).where(eq(schema.attachmentUploads.contentHash, hash));
  }

  private async upsertReportAttachment(vesselId: string, meta: AttachmentMeta): Promise<void> {
    const existing = await this.db
      .select({ id: schema.reportAttachments.id })
      .from(schema.reportAttachments)
      .where(
        and(
          eq(schema.reportAttachments.vesselId, vesselId),
          eq(schema.reportAttachments.reportId, meta.reportId),
          eq(schema.reportAttachments.versionNo, meta.versionNo),
          eq(schema.reportAttachments.contentHash, meta.contentHash),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    await this.db.insert(schema.reportAttachments).values({
      id: crypto.randomUUID(),
      vesselId,
      reportId: meta.reportId,
      versionNo: meta.versionNo,
      fieldName: meta.fieldName,
      filename: meta.filename,
      contentType: meta.contentType,
      contentHash: meta.contentHash,
      sizeBytes: meta.totalSize,
      receivedAt: new Date().toISOString(),
    });
  }

  /** What shore holds for one report version — the office-side read. */
  async listForReport(vesselId: string, reportId: string) {
    const rows = await this.db
      .select()
      .from(schema.reportAttachments)
      .where(and(eq(schema.reportAttachments.vesselId, vesselId), eq(schema.reportAttachments.reportId, reportId)))
      .orderBy(asc(schema.reportAttachments.versionNo), asc(schema.reportAttachments.filename));

    return rows.map((r) => ({
      id: r.id,
      reportId: r.reportId,
      versionNo: r.versionNo,
      fieldName: r.fieldName,
      filename: r.filename,
      contentType: r.contentType,
      contentHash: r.contentHash,
      sizeBytes: r.sizeBytes,
      receivedAt: toIso(r.receivedAt),
      // A row can exist before its bytes arrive: the association is
      // recorded on the first query, and the transfer may still be in
      // progress or have been interrupted. Saying so is the difference
      // between a broken download and an honest "not here yet".
      available: this.store.has(r.contentHash),
    }));
  }

  /** Path to stream a download from, or null if the bytes are not held. */
  resolveStored(contentHash: string): string | null {
    if (!CONTENT_HASH.test(contentHash)) return null;
    return this.store.resolve(contentHash);
  }
}
