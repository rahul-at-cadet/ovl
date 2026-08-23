import { Module } from '@nestjs/common';
import { SensorsService } from './sensors.service';
import { VmsService } from './vms.service';
import { VoyageService } from './voyage.service';

@Module({
  providers: [SensorsService, VmsService, VoyageService],
  exports: [SensorsService, VmsService, VoyageService],
})
export class SensorsModule {}
