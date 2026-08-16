import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async listReports(schemaName: string) {
    // Return latest versions of all reports for the schema
    return this.db.query.reportVersions.findMany({
      where: eq(schema.reportVersions.schemaKind, schemaName),
      orderBy: (reports, { desc }) => [desc(reports.receivedAt)],
    });
  }

  async getReport(reportId: string) {
    const versions = await this.db.query.reportVersions.findMany({
      where: eq(schema.reportVersions.reportId, reportId),
      orderBy: (reports, { desc }) => [desc(reports.versionNo)],
      limit: 1,
    });
    
    if (versions.length === 0) {
      throw new NotFoundException('Report not found');
    }
    
    return versions[0];
  }
}
