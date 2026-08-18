import { Module } from '@nestjs/common';
import { SchemaVersionsService } from './schema-versions.service';

@Module({
  providers: [SchemaVersionsService],
  exports: [SchemaVersionsService],
})
export class SchemaVersionsModule {}
