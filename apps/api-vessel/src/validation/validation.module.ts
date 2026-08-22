import { Module, forwardRef } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { ReportsModule } from '../reports/reports.module';

@Module({
  imports: [forwardRef(() => ReportsModule)],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
