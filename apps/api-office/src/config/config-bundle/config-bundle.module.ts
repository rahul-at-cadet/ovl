import { Module } from '@nestjs/common';
import { ConfigBundleService } from './config-bundle.service';

@Module({
  providers: [ConfigBundleService],
  exports: [ConfigBundleService],
})
export class ConfigBundleModule {}
