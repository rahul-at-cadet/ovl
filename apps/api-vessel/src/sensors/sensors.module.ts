import { Module } from '@nestjs/common';
import { SensorsService } from './sensors.service';
import { VmsService } from './vms.service';

@Module({
  providers: [SensorsService, VmsService],
  exports: [SensorsService, VmsService],
})
export class SensorsModule {}
