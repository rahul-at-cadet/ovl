import { Injectable, Inject } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../database/database.module';
import { ComplianceService } from '../config/compliance/compliance.service';
import { effectiveCadence } from '../config/logic/compliance';

const LOG_ABSTRACT_SCHEMA_KIND = 'log-abstract.json';

export interface VesselPositionView {
  id: string;
  name: string;
  imo: string;
  groups: string[];
  lat: number;
  lon: number;
  status: 'ok' | 'remarked' | 'overdue';
  asOf: string;
}

/**
 * Reconstructs decimal position from the Degree/Minutes/Hemisphere
 * triple the officer actually entered — mirrors ovl/office/httpapi/
 * vesselpositions.go's parseLogAbstractPosition (and the identical port
 * already sitting in apps/api-vessel/src/sensors/vms.service.ts's
 * readPosition, kept separate here since the two apps don't share code).
 * Returns null if any of the six sub-fields is missing — a vessel simply
 * doesn't appear on the map until a report has a full Position filled
 * in, rather than plotting a fabricated or partial coordinate.
 */
function readPosition(fields: Record<string, unknown>): { lat: number; lon: number } | null {
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
  return { lat, lon };
}

@Injectable()
export class VesselsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly complianceService: ComplianceService,
  ) {}

  /**
   * Ports ovl/office/httpapi/vesselpositions.go's handleListVesselPositions
   * for the Fleet Map: each vessel's most recent Log Abstract report (by
   * event time across all of that vessel's reports, not per-reportId
   * history), reduced to a plottable position + a 3-state status.
   * Status precedence matches the original exactly: overdue wins over
   * remarked (an unreviewed remarked report) wins over ok.
   */
  async getPositions(group?: string): Promise<VesselPositionView[]> {
    const allVessels = await this.db.select().from(schema.vessels);
    const vessels = group
      ? allVessels.filter((v) => ((v.groups as string[]) ?? []).includes(group))
      : allVessels;
    if (vessels.length === 0) return [];

    const reportRows = await this.db
      .select({
        vesselId: schema.reportVersions.vesselId,
        reportId: schema.reportVersions.reportId,
        versionNo: schema.reportVersions.versionNo,
        eventTime: schema.reportVersions.eventTime,
        fields: schema.reportVersions.fields,
      })
      .from(schema.reportVersions)
      .where(eq(schema.reportVersions.schemaKind, LOG_ABSTRACT_SCHEMA_KIND));

    const latestVersionByReport = new Map<string, (typeof reportRows)[number]>();
    for (const r of reportRows) {
      const key = `${r.vesselId}:${r.reportId}`;
      const existing = latestVersionByReport.get(key);
      if (!existing || r.versionNo > existing.versionNo) latestVersionByReport.set(key, r);
    }
    const latestByVessel = new Map<string, (typeof reportRows)[number]>();
    for (const r of latestVersionByReport.values()) {
      const existing = latestByVessel.get(r.vesselId);
      if (!existing || new Date(r.eventTime) > new Date(existing.eventTime)) latestByVessel.set(r.vesselId, r);
    }

    const remarkedRows = await this.db
      .select({ vesselId: schema.reportVersions.vesselId, reportId: schema.reportVersions.reportId })
      .from(schema.reportVersions)
      .where(eq(schema.reportVersions.state, 'remarked'));
    const reviewRows = await this.db
      .select({ vesselId: schema.reportReviews.vesselId, reportId: schema.reportReviews.reportId })
      .from(schema.reportReviews);
    const reviewedKeys = new Set(reviewRows.map((r) => `${r.vesselId}:${r.reportId}`));
    const unreviewedRemarkedVessels = new Set(
      remarkedRows
        .filter((r) => !reviewedKeys.has(`${r.vesselId}:${r.reportId}`))
        .map((r) => r.vesselId),
    );

    const cadenceRules = await this.complianceService.listCadenceRules();
    const now = new Date();

    const out: VesselPositionView[] = [];
    for (const v of vessels) {
      const latest = latestByVessel.get(v.id);
      if (!latest) continue;
      const pos = readPosition(latest.fields as Record<string, unknown>);
      if (!pos) continue;

      const groups = (v.groups as string[]) ?? [];
      const cadence = effectiveCadence(cadenceRules, v.id, groups);
      const hoursSince = (now.getTime() - new Date(latest.eventTime).getTime()) / (1000 * 60 * 60);

      let status: VesselPositionView['status'] = 'ok';
      if (hoursSince > cadence.maxGapHours) status = 'overdue';
      else if (unreviewedRemarkedVessels.has(v.id)) status = 'remarked';

      out.push({
        id: v.id,
        name: v.name,
        imo: v.imo,
        groups,
        lat: pos.lat,
        lon: pos.lon,
        status,
        asOf: new Date(latest.eventTime).toISOString(),
      });
    }
    return out;
  }
}
