import { Controller, Get, Param, Query, BadRequestException, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  async listReports(@Query('schema') schemaName: string) {
    if (!schemaName) throw new BadRequestException('schema query parameter is required');
    return this.reportsService.listReports(schemaName);
  }

  @Get(':id')
  async getReport(@Param('id') id: string) {
    return this.reportsService.getReport(id);
  }
}
