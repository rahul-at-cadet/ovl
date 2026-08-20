import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@ovl/vessel-database';
import { ReportsService } from '../reports/reports.service';

export interface VesselNotification {
  id: string;
  category: 'remarked' | 'invalidated' | 'overdue';
  schemaName: string;
  eventType: string;
  message: string;
  at: string;
  reportId: string;
}

/**
 * The vessel-side counterpart to office's NotificationsService — see
 * ovl/web/vessel/src/screens/NotificationBell.tsx's own comment on why
 * there is no read-state here at all, unlike office's notification
 * bell: a flagged report isn't a discrete event to dismiss, it's the
 * report's *current* lifecycle state, so it stops appearing the moment
 * the report is actually corrected rather than when someone dismisses
 * it. Everything here is derived fresh from `reports` on every call.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly reportsService: ReportsService,
  ) {}

  async list(): Promise<VesselNotification[]> {
    const reports = await this.reportsService.listReports();
    const out: VesselNotification[] = [];

    for (const r of reports) {
      if (r.state === 'remarked' || r.state === 'invalidated') {
        out.push({
          id: `${r.state}:${r.reportId}`,
          category: r.state,
          schemaName: r.schemaName,
          eventType: r.eventType,
          message: r.state === 'remarked' ? 'Remarked by office' : 'Invalidated',
          at: r.updatedAt,
          reportId: r.reportId,
        });
      }
    }

    // Same overdue cadence rule as the Dashboard's own KPI (settings'
    // reportingIntervalHours + a 2h grace period) — kept identical so
    // this bell and the Dashboard banner never disagree about whether
    // a report is overdue.
    const settingsRows = await this.db.select().from(schema.configStore);
    const reportingIntervalHours = Number(
      settingsRows.find((row) => row.key === 'reportingIntervalHours')?.value,
    );
    const recent = reports.filter((r) => r.state !== 'draft');
    if (recent.length > 0 && reportingIntervalHours) {
      const lastReportTime = new Date(recent[0].createdAt).getTime();
      const maxGapHours = reportingIntervalHours + 2;
      const hoursSince = (Date.now() - lastReportTime) / (1000 * 60 * 60);
      if (hoursSince > maxGapHours) {
        const overdueHours = Math.floor(hoursSince - maxGapHours);
        out.push({
          id: `overdue:${recent[0].reportId}`,
          category: 'overdue',
          schemaName: recent[0].schemaName,
          eventType: recent[0].eventType,
          message: `Overdue by ${overdueHours}h`,
          at: new Date(lastReportTime + maxGapHours * 60 * 60 * 1000).toISOString(),
          reportId: recent[0].reportId,
        });
      }
    }

    out.sort((a, b) => (a.at < b.at ? 1 : -1));
    return out;
  }
}
