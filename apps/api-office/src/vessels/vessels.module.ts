import { Module } from '@nestjs/common';
import { VesselUsersService } from './vessel-users.service';

@Module({
  providers: [VesselUsersService],
  exports: [VesselUsersService],
})
export class VesselsModule {}
