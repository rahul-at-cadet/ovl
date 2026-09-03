import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { RestoreBundleService } from './restore-bundle.service';

@Module({
  controllers: [BackupController],
  providers: [RestoreBundleService],
  exports: [RestoreBundleService],
})
export class SystemModule {}
