import { Module } from '@nestjs/common';
import { VesselUsersService } from './vessel-users.service';
import { VesselsService } from './vessels.service';
import { RestoreBundleService } from './restore-bundle.service';
import { ComplianceModule } from '../config/compliance/compliance.module';
import { ConfigBundleModule } from '../config/config-bundle/config-bundle.module';

@Module({
  imports: [ComplianceModule, ConfigBundleModule],
  providers: [VesselUsersService, VesselsService, RestoreBundleService],
  exports: [VesselUsersService, VesselsService, RestoreBundleService],
})
export class VesselsModule {}
