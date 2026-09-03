import { Global, Module } from '@nestjs/common';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import { ReportsModule } from '../reports/reports.module';
import { SensorsModule } from '../sensors/sensors.module';
import { SyncModule } from '../sync/sync.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemModule } from '../system/system.module';

@Global()
@Module({
  imports: [ReportsModule, SensorsModule, SyncModule, AuthModule, NotificationsModule, SystemModule],
  providers: [TrpcService, TrpcRouter],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
