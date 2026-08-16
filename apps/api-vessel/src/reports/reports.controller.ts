import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { ReportsService } from './reports.service';
import { SchemaRegistryService } from './schema-registry.service';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

// --- TypeBox Schemas ---
const CreateReportSchema = Type.Object({
  schemaName: Type.String(),
  eventType: Type.String(),
  eventTime: Type.String(), // ISO date string
  fields: Type.Record(Type.String(), Type.Any()),
});
const CreateReportCompiler = TypeCompiler.Compile(CreateReportSchema);

const SaveSectionSchema = Type.Object({
  section: Type.String(),
  changes: Type.Record(Type.String(), Type.Any()),
});
const SaveSectionCompiler = TypeCompiler.Compile(SaveSectionSchema);
// -----------------------

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly schemaRegistry: SchemaRegistryService,
  ) {}

  @Post()
  async createReport(@Body() body: unknown, @Req() req: any) {
    if (!CreateReportCompiler.Check(body)) {
      throw new BadRequestException('Invalid report data');
    }
    const reportData = body;

    // Dynamic Schema Validation!
    this.schemaRegistry.validate(reportData.schemaName, reportData.fields);

    // Mock user for now until auth guard is integrated
    const username = req.user?.username || 'vessel-admin';
    return this.reportsService.createReport(reportData, username);
  }

  @Get()
  async listReports(@Query('schema') schemaName: string) {
    if (!schemaName)
      throw new BadRequestException('schema query parameter is required');
    return this.reportsService.listReports(schemaName);
  }

  @Get(':id')
  async getReport(@Param('id') id: string) {
    return this.reportsService.getReport(id);
  }

  @Patch(':id/section')
  async saveSection(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: any,
  ) {
    if (!SaveSectionCompiler.Check(body)) {
      throw new BadRequestException('Invalid section changes data');
    }
    const sectionData = body;

    // To do full validation on a section save, we would merge with existing and validate.
    // For now, we'll just let the generic save go through or we can load the report and validate.
    // The legacy app validates on /check or blur.

    const username = req.user?.username || 'vessel-admin';
    return this.reportsService.saveSection(id, sectionData, username);
  }

  @Post(':id/submit')
  async submitReport(@Param('id') id: string, @Req() req: any) {
    const username = req.user?.username || 'vessel-admin';
    return this.reportsService.submitReport(id, username);
  }

  @Post('attachments')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttachment(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    // In a real app, this would save to disk/S3 and return the hash
    const contentHash = randomBytes(16).toString('hex');
    return {
      contentHash,
      filename: file.originalname,
      size: file.size,
      contentType: file.mimetype,
    };
  }
}
