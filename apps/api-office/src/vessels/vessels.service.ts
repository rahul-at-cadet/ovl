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
 * Reads a single-letter hemisphere indicator and returns +1/-1 to
 * multiply the coordinate by — ports vesselpositions.go's asHemisphere.
 * Returns null for anything that isn't one of the two expected letters:
 * the field is free text (no enumRef), so an unrecognised value means
 * the officer's intent is genuinely unknown, not "assume the positive
 * hemisphere". Treating a stray letter as North/East silently plots the
 * vessel in the wrong half of the world.
 */
function readHemisphere(value: string, positive: string, negative: string): number | null {
  const first = value.charAt(0).toUpperCase();
  if (first === positive) return 1;
  if (first === negative) return -1;
  return null;
}

/**
 * Reconstructs decimal position from the Degree/Minutes/Hemisphere
 * triple the officer actually entered — mirrors ovl/office/httpapi/
 * vesselpositions.go's parseLogAbstractPosition (and the identical port
 * already sitting in apps/api-vessel/src/sensors/vms.service.ts's
 * readPosition, kept separate here since the two apps don't share code).
 * Returns null if any of the six sub-fields is missing, if a hemisphere
 * letter is unrecognised, or if the result falls outside real
 * lat/lon bounds — a vessel simply doesn't appear on the map until a
 * report has a full, sane Position filled in, rather than plotting a
 * fabricated, partial or impossible coordinate.
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

  const latSign = readHemisphere(latHemi, 'N', 'S');
  const lonSign = readHemisphere(lonHemi, 'E', 'W');
  if (latSign === null || lonSign === null) return null;

  // NaN/Infinity would slip past every comparison below and reach
  // Leaflet as an unplottable marker, so they're excluded up front.
  if (!Number.isFinite(latDeg) || !Number.isFinite(latMin) || !Number.isFinite(lonDeg) || !Number.isFinite(lonMin)) {
    return null;
  }

  // Degrees-and-decimal-minutes (the DDM form this schema uses: whole
  // degrees + decimal minutes + a hemisphere letter) only has meaning
  // when minutes stay under 60 and neither component is signed — the
  // hemisphere letter carries the sign, so a negative degree is
  // contradictory input rather than a southern/western coordinate.
  // Neither the Go original nor this port checked it, which let a
  // fat-fingered 45°90' resolve to a perfectly plausible-looking 46.5°
  // and plot the vessel ~90 nm from where it actually was.
  if (latDeg < 0 || latMin < 0 || lonDeg < 0 || lonMin < 0) return null;
  if (latMin >= 60 || lonMin >= 60) return null;

  const lat = (latDeg + latMin / 60) * latSign;
  const lon = (lonDeg + lonMin / 60) * lonSign;

  // The range guard the Go original applies and this port had dropped:
  // without it a typo'd 500-degree latitude reaches the fleet map as a
  // vessel that's listed but has no drawable marker.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

/**
 * readPosition is module-private (it's an implementation detail of
 * getPositions, not part of the service's API) but its rules are the
 * fleet map's whole correctness story, so it's exposed under an
 * explicitly test-only name rather than being left untested or promoted
 * to a public method.
 */
export const readPositionForTest = readPosition;

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
    // The most recent report that actually carries a position, not
    // simply the most recent report. Position isn't schema-mandatory and
    // most Log Abstracts leave it blank, so keying off the latest report
    // outright made a vessel vanish from the map the moment it filed one
    // without a Position — even though shore knew exactly where it was
    // an hour earlier. This is what the Go original's own comment
    // describes ("whichever report mentioned it last"); its SQL takes
    // the latest row regardless, which is the behaviour that hides
    // vessels. Staleness is surfaced via asOf rather than by dropping
    // the marker.
    const latestByVessel = new Map<string, (typeof reportRows)[number]>();
    for (const r of latestVersionByReport.values()) {
      if (!readPosition(r.fields as Record<string, unknown>)) continue;
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
