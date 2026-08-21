import { Controller, Get, Res, Req, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { Response, Request } from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { VesselAuthGuard } from '../auth/vessel-auth.guard';

@Controller('system/backup')
export class BackupController {
  @Get('download')
  @UseGuards(VesselAuthGuard)
  async downloadBackup(@Req() req: Request & { user?: { role?: string } }, @Res() res: Response) {
    // A full DB backup contains every vessel's data — mirrors
    // ovl/vessel/httpapi/backup.go's own gate (user.IsSuperAdmin(),
    // i.e. Master only), not just "any authenticated user".
    if (req.user?.role?.toLowerCase() !== 'master') {
      throw new HttpException('Only the Master account may download a backup', HttpStatus.FORBIDDEN);
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
