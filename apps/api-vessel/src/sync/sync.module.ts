import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { AuthModule } from '../auth/auth.module';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [AuthModule, SystemModule],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
