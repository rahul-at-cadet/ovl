import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { SchemaRegistryService } from './schema-registry.service';
import { AttachmentsController } from './attachments.controller';

@Module({
  controllers: [AttachmentsController],
  providers: [ReportsService, SchemaRegistryService],
  exports: [ReportsService, SchemaRegistryService],
})
export class ReportsModule {}
