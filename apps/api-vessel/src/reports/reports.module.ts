import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SchemaRegistryService } from './schema-registry.service';
import { AttachmentsController } from './attachments.controller';

@Module({
  controllers: [ReportsController, AttachmentsController],
  providers: [ReportsService, SchemaRegistryService],
  exports: [ReportsService, SchemaRegistryService],
})
export class ReportsModule {}
