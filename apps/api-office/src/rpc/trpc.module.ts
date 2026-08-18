import { Module } from '@nestjs/common';
import { TrpcRouter } from './trpc.router';
import { SchemaVersionsModule } from '../config/schema-versions/schema-versions.module';
import { FieldPolicyModule } from '../config/field-policy/field-policy.module';
import { ComplianceModule } from '../config/compliance/compliance.module';
import { ConfigBundleModule } from '../config/config-bundle/config-bundle.module';

@Module({
  imports: [SchemaVersionsModule, FieldPolicyModule, ComplianceModule, ConfigBundleModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {}
