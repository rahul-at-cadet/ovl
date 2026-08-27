import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { eq, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDbService,
  ) {}

  async listReports(schemaName: string) {
    return this.tenantDb.withTenant(async (db) => {
      // Return latest versions of all reports for the schema
      return db.query.reportVersions.findMany({
        where: eq(schema.reportVersions.schemaKind, schemaName),
        orderBy: (reports, { desc }) => [desc(reports.receivedAt)],
      });
  }, { readOnly: true });
  }

  async getReport(reportId: string) {
    return this.tenantDb.withTenant(async (db) => {
      const versions = await db.query.reportVersions.findMany({
        where: eq(schema.reportVersions.reportId, reportId),
        orderBy: (reports, { desc }) => [desc(reports.versionNo)],
        limit: 1,
      });
    
      if (versions.length === 0) {
        throw new NotFoundException('Report not found');
      }
    
      return versions[0];
  }, { readOnly: true });
  }
}
