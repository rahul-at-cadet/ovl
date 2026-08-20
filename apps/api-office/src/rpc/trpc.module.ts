import { Module } from '@nestjs/common';
import { TrpcRouter } from './trpc.router';
import { SchemaVersionsModule } from '../config/schema-versions/schema-versions.module';
import { FieldPolicyModule } from '../config/field-policy/field-policy.module';
import { ComplianceModule } from '../config/compliance/compliance.module';
import { ConfigBundleModule } from '../config/config-bundle/config-bundle.module';
import { VesselsModule } from '../vessels/vessels.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [SchemaVersionsModule, FieldPolicyModule, ComplianceModule, ConfigBundleModule, VesselsModule, NotificationsModule, UsersModule],
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {}
