import { Injectable, Inject } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../database/database.module';
import { ComplianceService } from '../config/compliance/compliance.service';
import { effectiveCadence } from '../config/logic/compliance';

const LOG_ABSTRACT_SCHEMA_KIND = 'log-abstract.json';

/**
 * How far back to look per vessel for a position that actually validates.
 *
 * Bounded rather than unbounded: the query would otherwise return every
 * positioned report the fleet has ever filed, which is the in-memory
 * behaviour this replaced. A vessel whose last 25 positioned reports are
 * all malformed has a data problem no map can paper over.
 */
const POSITION_CANDIDATES_PER_VESSEL = 25;

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

    /**
     * At most one row per vessel, resolved in the database.
     *
     * This previously selected every log-abstract report_version — each
     * carrying its whole `fields` JSONB, which is hundreds of keys wide —
     * and then deduplicated, filtered and ranked them in Node. So painting
     * the fleet map read the entire reporting history of the fleet into
     * memory and discarded all but one row per vessel.
     *
     * The two DISTINCT ONs do that reduction in SQL: the first keeps the
     * latest version of each report, the second keeps each vessel's most
     * recent report *that carries a position*. Only the six position
     * fields are projected, not the whole document.
     *
     * That second step is the behaviour worth preserving: position is not
     * schema-mandatory and most Log Abstracts leave it blank, so keying
     * off the latest report outright made a vessel vanish from the map the
     * moment it filed one without a Position — even though shore knew
     * exactly where it was an hour earlier. Staleness is surfaced through
     * asOf instead of by dropping the marker.
     */
    const positionRows = await this.db.execute<{
      vessel_id: string;
      event_time: string;
      lat_deg: unknown;
      lat_min: unknown;
      lat_hemi: unknown;
      lon_deg: unknown;
      lon_min: unknown;
      lon_hemi: unknown;
    }>(sql`
      WITH latest_version AS (
        SELECT DISTINCT ON (rv.vessel_id, rv.report_id)
          rv.vessel_id, rv.event_time,
          rv.fields->'Latitude_Degree'      AS lat_deg,
          rv.fields->'Latitude_Minutes'     AS lat_min,
          rv.fields->'Latitude_North_South' AS lat_hemi,
          rv.fields->'Longitude_Degree'     AS lon_deg,
          rv.fields->'Longitude_Minutes'    AS lon_min,
          rv.fields->'Longitude_East_West'  AS lon_hemi
        FROM report_versions rv
        WHERE rv.schema_kind = ${LOG_ABSTRACT_SCHEMA_KIND}
        ORDER BY rv.vessel_id, rv.report_id, rv.version_no DESC
      )
      SELECT vessel_id, event_time, lat_deg, lat_min, lat_hemi, lon_deg, lon_min, lon_hemi
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY vessel_id ORDER BY event_time DESC) AS rn
        FROM latest_version
        -- Presence only. SQL can tell whether the six keys exist; it
        -- cannot tell whether "X" is a hemisphere or whether 90 is a
        -- legal minute value, and duplicating those rules here would put
        -- the map's correctness in two places that can disagree.
        WHERE lat_deg IS NOT NULL AND lat_min IS NOT NULL AND lat_hemi IS NOT NULL
          AND lon_deg IS NOT NULL AND lon_min IS NOT NULL AND lon_hemi IS NOT NULL
      ) ranked
      -- Several candidates per vessel, newest first, rather than only the
      -- newest: a report can carry all six keys and still hold nonsense
      -- (a stray hemisphere letter, an impossible latitude). Taking just
      -- the top row let such a report shadow the good position behind it
      -- and drop the vessel off the map entirely. readPosition below walks
      -- these in order and takes the first that actually validates, which
      -- is what the previous in-memory version did across all history.
      WHERE rn <= ${POSITION_CANDIDATES_PER_VESSEL}
      ORDER BY vessel_id, event_time DESC
    `);

    // Validation stays in TypeScript: SQL can tell whether the six keys
    // are present, but not whether the values are sane. readPosition owns
    // the range, hemisphere and minutes-under-60 rules, with its own tests.
    const latestByVessel = new Map<string, { eventTime: string; pos: { lat: number; lon: number } }>();
    for (const r of positionRows.rows) {
      // Rows arrive newest-first per vessel, so the first that validates
      // wins and later (older) candidates are skipped.
      if (latestByVessel.has(r.vessel_id)) continue;
      const pos = readPosition({
        Latitude_Degree: r.lat_deg,
        Latitude_Minutes: r.lat_min,
        Latitude_North_South: r.lat_hemi,
        Longitude_Degree: r.lon_deg,
        Longitude_Minutes: r.lon_min,
        Longitude_East_West: r.lon_hemi,
      });
      if (!pos) continue;
      latestByVessel.set(r.vessel_id, { eventTime: r.event_time, pos });
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
      // Position was already resolved and validated above.
      if (!latest) continue;
      const pos = latest.pos;

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
