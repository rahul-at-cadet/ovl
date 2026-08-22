import { Module, forwardRef } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { SchemaRegistryService } from './schema-registry.service';
import { AttachmentsController } from './attachments.controller';
import { ValidationModule } from '../validation/validation.module';

@Module({
  // ValidationModule needs SchemaRegistryService (provided here) and
  // ReportsService needs ValidationService (provided there) — a genuine
  // module cycle, resolved with forwardRef on both sides.
  imports: [forwardRef(() => ValidationModule)],
  controllers: [AttachmentsController],
  providers: [ReportsService, SchemaRegistryService],
  exports: [ReportsService, SchemaRegistryService],
})
export class ReportsModule {}
