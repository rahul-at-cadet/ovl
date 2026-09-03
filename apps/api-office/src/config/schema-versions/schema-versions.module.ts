import { Module } from '@nestjs/common';
import { SchemaVersionsController } from './schema-versions.controller';
import { SchemaVersionsService } from './schema-versions.service';

@Module({
  controllers: [SchemaVersionsController],
  providers: [SchemaVersionsService],
  exports: [SchemaVersionsService],
})
export class SchemaVersionsModule {}
