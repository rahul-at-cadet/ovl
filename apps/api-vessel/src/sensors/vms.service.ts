import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';

export interface VoyagePosition {
  latitude: number;
  longitude: number;
  text: string;
}

export interface VoyageData {
  voyageNumber: string;
  fromPort: string;
  toPort: string;
  eta: string | null;
  departedAt: string | null;
  lastReportAt: string;
  position: VoyagePosition | null;
  distanceSailedNm: number | null;
  distanceRemainingNm: number | null;
  progressPercent: number | null;
}

@Injectable()
export class VmsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  /**
   * Derives the current voyage summary from the vessel's own submitted
   * log-abstract reports — mirrors ovl/vessel/httpapi/voyage.go's
   * computeVoyageSummary exactly, including its honesty rule: fields
   * whose source data was never entered on a report come back null,
   * never a fabricated placeholder. There's no separate "voyage" entity
   * anywhere in this app — this read-model can't drift from what was
   * actually reported because it's derived fresh from `reports.fields`
   * on every call.
   */
  async getActiveVoyage(): Promise<VoyageData | null> {
    const rows = await this.db.query.reports.findMany({
      where: eq(schema.reports.schemaName, 'log-abstract.json'),
    });
    if (rows.length === 0) return null;

    const latestByReportId = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = latestByReportId.get(row.reportId);
      if (!existing || row.versionNo > existing.versionNo) {
        latestByReportId.set(row.reportId, row);
      }
    }
    const submitted = Array.from(latestByReportId.values())
      .filter((r) => r.state === 'submitted')
      .sort((a, b) => (a.eventTime < b.eventTime ? -1 : 1));
    if (submitted.length === 0) return null;

    const latest = submitted[submitted.length - 1];
    const lf = latest.fields as Record<string, any>;

    const str = (name: string): string => (typeof lf[name] === 'string' && lf[name] ? lf[name] : '');
    const num = (name: string): number | null => (typeof lf[name] === 'number' ? lf[name] : null);

    const voyageNumber = str('Voyage_Number');
    const voyage: VoyageData = {
      voyageNumber,
      fromPort: str('Voyage_From'),
      toPort: str('Voyage_To'),
      eta: str('ETA') || null,
      departedAt: null,
      lastReportAt: latest.eventTime,
      position: readPosition(lf),
      distanceSailedNm: null,
      distanceRemainingNm: null,
      progressPercent: null,
    };

    if (!voyageNumber) return voyage;

    const sameVoyage = submitted.filter((r) => (r.fields as Record<string, any>).Voyage_Number === voyageNumber);
    if (sameVoyage.length === 0) return voyage;

    voyage.departedAt = sameVoyage[0].eventTime;

    let sailed = 0;
    let haveSailed = false;
    for (const r of sameVoyage) {
      const d = (r.fields as Record<string, any>).Distance;
      if (typeof d === 'number') {
        sailed += d;
        haveSailed = true;
      }
    }
    if (!haveSailed) return voyage;
    voyage.distanceSailedNm = sailed;

    const remaining = num('Distance_To_Go');
    if (remaining === null) return voyage;
    voyage.distanceRemainingNm = remaining;

    const total = sailed + remaining;
    if (total > 0) {
      voyage.progressPercent = Math.min(100, (sailed / total) * 100);
    }
    return voyage;
  }
}

/**
 * Reconstructs decimal position from the Degree/Minutes/Hemisphere
 * triple the officer actually entered — same fields, same nil-if-
 * incomplete rule as voyage.go's readPosition.
 */
function readPosition(fields: Record<string, any>): VoyagePosition | null {
  const latDeg = fields.Latitude_Degree;
  const latMin = fields.Latitude_Minutes;
  const latHemi = fields.Latitude_North_South;
  const lonDeg = fields.Longitude_Degree;
  const lonMin = fields.Longitude_Minutes;
  const lonHemi = fields.Longitude_East_West;
  if (
    typeof latDeg !== 'number' ||
    typeof latMin !== 'number' ||
    typeof latHemi !== 'string' ||
    typeof lonDeg !== 'number' ||
    typeof lonMin !== 'number' ||
    typeof lonHemi !== 'string'
  ) {
    return null;
  }
  let lat = latDeg + latMin / 60;
  if (latHemi.toUpperCase() === 'S') lat = -lat;
  let lon = lonDeg + lonMin / 60;
  if (lonHemi.toUpperCase() === 'W') lon = -lon;
  const text = `${latDeg.toFixed(0)}°${latMin.toFixed(2)}′${latHemi.toUpperCase()} ${lonDeg.toFixed(0)}°${lonMin.toFixed(2)}′${lonHemi.toUpperCase()}`;
  return { latitude: lat, longitude: lon, text };
}
