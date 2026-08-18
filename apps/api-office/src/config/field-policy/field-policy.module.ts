import { Module } from '@nestjs/common';
import { FieldPolicyService } from './field-policy.service';

@Module({
  providers: [FieldPolicyService],
  exports: [FieldPolicyService],
})
export class FieldPolicyModule {}
