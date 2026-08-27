import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { AuthModule } from '../auth/auth.module';
import { ReportsModule } from '../reports/reports.module';

@Module({
  // ReportsModule provides SchemaSyncService and SchemaRegistryService, which
  // the schema pull needs. No cycle: reports does not import sync.
  imports: [AuthModule, ReportsModule],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
