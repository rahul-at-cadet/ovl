import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
