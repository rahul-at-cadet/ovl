import {
  Controller,
  Post,
  Get,
  Delete,
  UseInterceptors,
  UseGuards,
  UploadedFile,
  Body,
  Param,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response, Request } from 'express';
import { VesselAuthGuard } from '../auth/vessel-auth.guard';
import { AttachmentsService } from './attachments.service';

type AuthedRequest = Request & { user?: { username: string } };

@Controller('reports/:reportId/attachments')
@UseGuards(VesselAuthGuard)
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 + 64 * 1024 } }))
  async upload(
    @Param('reportId') reportId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('fieldName') fieldName: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.attachmentsService.upload(reportId, file, fieldName, req.user!.username);
  }

  @Get()
  async list(@Param('reportId') reportId: string) {
    return this.attachmentsService.list(reportId);
  }

  @Get(':attachmentId')
  async download(@Param('reportId') reportId: string, @Param('attachmentId') attachmentId: string, @Res() res: Response) {
    const { buffer, contentType, filename } = await this.attachmentsService.download(reportId, attachmentId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
    res.send(buffer);
  }

  @Delete(':attachmentId')
  async delete(@Param('reportId') reportId: string, @Param('attachmentId') attachmentId: string) {
    return this.attachmentsService.delete(reportId, attachmentId);
  }
}
