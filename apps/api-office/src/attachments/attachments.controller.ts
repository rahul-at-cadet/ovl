import {
  Controller,
  Get,
  Param,
  NotFoundException,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { AuthGuard } from '../auth/auth.guard';
import { AttachmentsService } from './attachments.service';

/**
 * Serving a synced attachment back to a reviewer.
 *
 * A REST route rather than a tRPC procedure because this returns bytes:
 * base64 through a JSON envelope would inflate an 8 MB photo by a third
 * and hold the whole thing in memory on both ends. Streamed from the
 * content-addressed store instead.
 */
@Controller('attachments')
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Addressed by the report-attachment row rather than by content hash,
   * so a caller cannot fish for arbitrary stored objects by guessing
   * hashes — the row is what ties this content to a vessel and a report
   * the reviewer is entitled to see.
   */
  @Get(':vesselId/:reportId/:attachmentId')
  async download(
    @Param('vesselId') vesselId: string,
    @Param('reportId') reportId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const rows = await this.attachments.listForReport(vesselId, reportId);
    const row = rows.find((r) => r.id === attachmentId);
    if (!row) throw new NotFoundException('No such attachment for this report.');

    const filePath = this.attachments.resolveStored(row.contentHash);
    if (!filePath) {
      // The association exists but the bytes do not — the transfer is
      // still in progress, was interrupted, or the stored object failed
      // its integrity check. Distinct from "no such attachment", and the
      // reviewer needs to know which.
      throw new NotFoundException('This attachment has not finished transferring from the vessel yet.');
    }

    res.setHeader('Content-Type', row.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(row.sizeBytes));
    // Always an attachment, never inline: this is operator-supplied
    // content and must not be rendered in the office origin.
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/["\\]/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(filePath).pipe(res);
  }
}
