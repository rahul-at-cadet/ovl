import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { AttachmentStore } from './attachment-store';
import { VesselDatabase } from '../database/database.module';
import { attachmentsDir } from '../system/paths';
import { ReportsService } from './reports.service';
import { ConflictError, InvalidInputError, NotFoundError } from '../common/app-error';

// Architecture 15's stated scope ("images... PDFs") and hard size cap —
// the server enforces this itself rather than trusting client-side
// processing alone.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function isAllowedContentType(ct: string): boolean {
  return ct.startsWith('image/') || ct === 'application/pdf';
}

export interface AttachmentView {
  id: string;
  reportId: string;
  versionNo: number;
  fieldName: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
  synced: boolean;
}

function toView(a: typeof schema.attachments.$inferSelect): AttachmentView {
  return {
    id: a.id,
    reportId: a.reportId,
    versionNo: a.versionNo,
    fieldName: a.fieldName,
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    uploadedAt: a.uploadedAt,
    uploadedBy: a.uploadedBy,
    synced: a.syncedAt != null,
  };
}

/**
 * Ports ovl/vessel/httpapi/attachments.go + pkg/attachmentstore. File
 * bytes live in a content-addressed filesystem store (sha256, sharded
 * two hex chars deep); this table is what a report's Attachments
 * section actually lists/downloads/deletes by. `synced` is always false
 * here — the original's office-sync path is chunked binary RPC that
 * isn't ported (see the attachments table's own schema comment); never
 * fabricated as true.
 */
@Injectable()
export class AttachmentsService {
  private readonly store: AttachmentStore;

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly reportsService: ReportsService,
    // Rooted on the database's directory, not process.cwd(): a snapshot
    // copies the store alongside the database, and the two have to agree
    // on where it is. See system/paths.ts.
    private readonly database: VesselDatabase,
  ) {
    this.store = new AttachmentStore(attachmentsDir(this.database.dataDir));
  }

  async upload(
    reportId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    fieldName: string | undefined,
    username: string,
  ): Promise<AttachmentView> {
    if (!isAllowedContentType(file.mimetype)) {
      throw new InvalidInputError('only images and PDFs are accepted');
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new InvalidInputError(`attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit`);
    }

    const report = await this.reportsService.loadEditableReport(reportId);
    const contentHash = this.store.put(file.buffer);
    const now = new Date().toISOString();

    const row = {
      id: randomUUID(),
      reportId,
      versionNo: report.versionNo,
      fieldName: fieldName || 'Attachments',
      filename: file.originalname,
      contentType: file.mimetype,
      contentHash,
      sizeBytes: file.size,
      uploadedAt: now,
      uploadedBy: username,
    };
    await this.db.insert(schema.attachments).values(row);
    return toView({ ...row, syncedAt: null });
  }

  /** Lists reportId's attachments for its latest version — viewable regardless of report state. */
  async list(reportId: string): Promise<AttachmentView[]> {
    const report = await this.reportsService.getReport(reportId);
    const rows = await this.db.query.attachments.findMany({
      where: and(eq(schema.attachments.reportId, reportId), eq(schema.attachments.versionNo, report.versionNo)),
      orderBy: (a, { asc }) => [asc(a.uploadedAt)],
    });
    return rows.map(toView);
  }

  private async loadOwnedAttachment(reportId: string, attachmentId: string) {
    const rows = await this.db.query.attachments.findMany({ where: eq(schema.attachments.id, attachmentId) });
    const a = rows[0];
    if (!a || a.reportId !== reportId) {
      throw new NotFoundError('attachment not found');
    }
    return a;
  }

  async download(reportId: string, attachmentId: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const a = await this.loadOwnedAttachment(reportId, attachmentId);
    const buffer = this.store.get(a.contentHash);
    if (!buffer) {
      throw new NotFoundError('attachment content not found');
    }
    return { buffer, contentType: a.contentType, filename: a.filename };
  }

  /** Gated to draft/ready and to the report's currently-editable version, matching every other field's immutability-after-submit rule. */
  async delete(reportId: string, attachmentId: string): Promise<{ deleted: true }> {
    const report = await this.reportsService.loadEditableReport(reportId);
    const a = await this.loadOwnedAttachment(reportId, attachmentId);
    if (a.versionNo !== report.versionNo) {
      throw new ConflictError('attachment does not belong to the current editable version');
    }
    await this.db.delete(schema.attachments).where(eq(schema.attachments.id, attachmentId));
    return { deleted: true };
  }
}
