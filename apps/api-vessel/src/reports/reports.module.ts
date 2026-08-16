import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SchemaRegistryService } from './schema-registry.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, SchemaRegistryService],
  exports: [ReportsService, SchemaRegistryService],
})
export class ReportsModule {}
