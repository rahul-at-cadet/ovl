import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ComplianceModule } from '../config/compliance/compliance.module';

@Module({
  imports: [ComplianceModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
