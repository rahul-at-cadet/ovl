import { Controller, Get, Res, Req, HttpException, HttpStatus } from '@nestjs/common';
import { Response, Request } from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

@Controller('system/backup')
export class BackupController {
  @Get('download')
  async downloadBackup(@Req() req: Request, @Res() res: Response) {
    // Check if token exists - mock auth check
    if (!req.cookies?.['vessel_auth_token']) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    try {
      const dbPath = path.join(process.cwd(), 'vessel.sqlite');
      
      if (!fs.existsSync(dbPath)) {
        throw new HttpException('Database file not found', HttpStatus.NOT_FOUND);
      }

      // We perform a safe backup by connecting to the DB and calling SQLite's native backup API,
      // or we can just copy the file since WAL mode allows it, but it's safer to use VACUUM INTO.
      const backupDir = path.join(process.cwd(), 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const backupFilename = `vessel_backup_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.sqlite`;
      const backupFilePath = path.join(backupDir, backupFilename);

      // Connect using better-sqlite3 and vacuum into new file
      const db = new Database(dbPath, { readonly: true });
      db.exec(`VACUUM INTO '${backupFilePath.replace(/'/g, "''")}'`);
      db.close();

      res.download(backupFilePath, 'vessel_backup.sqlite', (err) => {
        // Clean up the temporary backup file after download completes
        if (fs.existsSync(backupFilePath)) {
          fs.unlinkSync(backupFilePath);
        }
      });
    } catch (err: any) {
      throw new HttpException(`Failed to generate backup: ${err.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
