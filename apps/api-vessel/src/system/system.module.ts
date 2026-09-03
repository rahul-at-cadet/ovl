import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { RestoreBundleService } from './restore-bundle.service';

@Module({
  controllers: [BackupController],
  providers: [BackupService, RestoreBundleService],
  exports: [BackupService, RestoreBundleService],
})
export class SystemModule {}
