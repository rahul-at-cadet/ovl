import { Module } from '@nestjs/common';
import { VesselUsersService } from './vessel-users.service';
import { VesselsService } from './vessels.service';
import { ComplianceModule } from '../config/compliance/compliance.module';

@Module({
  imports: [ComplianceModule],
  providers: [VesselUsersService, VesselsService],
  exports: [VesselUsersService, VesselsService],
})
export class VesselsModule {}
