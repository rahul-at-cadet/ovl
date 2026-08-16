import { Controller, Post, UseInterceptors, UploadedFile, Param, Get, Res, Req, HttpException, HttpStatus } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response, Request } from 'express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// In a real app, this would be injected via a service.
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

@Controller('reports/:reportId/attachments')
export class AttachmentsController {
  @Post()
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: UPLOAD_DIR,
      filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomUUID();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
      }
    }),
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit
    }
  }))
  async uploadAttachment(@Param('reportId') reportId: string, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) {
      throw new HttpException('No file provided', HttpStatus.BAD_REQUEST);
    }
    
    // Check if token exists - mock auth check
    if (!req.cookies?.['vessel_auth_token']) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    
    // In a real system, we would insert an attachment record into the DB linked to the reportId.
    return {
      success: true,
      fileId: path.basename(file.filename, path.extname(file.filename)),
      filename: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      url: `/reports/${reportId}/attachments/${path.basename(file.filename)}` // Mock URL
    };
  }
}
