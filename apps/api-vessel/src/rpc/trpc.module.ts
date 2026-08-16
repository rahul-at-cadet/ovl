import { Global, Module } from '@nestjs/common';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import { ReportsModule } from '../reports/reports.module';
import { SensorsModule } from '../sensors/sensors.module';

@Global()
@Module({
  imports: [ReportsModule, SensorsModule],
  providers: [TrpcService, TrpcRouter],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
