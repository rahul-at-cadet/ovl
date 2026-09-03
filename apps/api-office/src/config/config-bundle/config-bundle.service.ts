import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, or, lt, gt, gte, lte, asc, desc, inArray, ilike, sql, type SQL } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../../database/database.module';
import { toIso, toIsoOrNull } from '../../common/iso-time';

/**
 * How many vessels the per-vessel breakdown returns. Bounded because a
 * large fleet would otherwise turn a summary into a second, unpaginated
 * list; the ordering puts the ships that are actually failing first, so
 * the cut falls on the ones nobody needs to see.
 */
const SYNC_METRICS_VESSEL_LIMIT = 20;

export type SyncHistorySort = 'newest' | 'oldest';

export interface SyncHistoryFilters {
  vesselId?: string;
  /** Empty or absent means every outcome, not none. */
  outcomes?: string[];
  /** Inclusive ISO bounds on received_at. */
  from?: string;
  to?: string;
  /** Matches vessel name or IMO, shore-authored or as the ship reported it. */
  search?: string;
  bundleId?: string;
}
import { Scope, ScopeType, validateScope } from '../logic/scope';
import { FieldPolicyAssignment } from '../logic/fieldPolicy';
import { ProfileAssignment, CadenceRule, RuleSeverityAssignment } from '../logic/compliance';
import {
  ComposedBundleContent,
  BundleAssignmentRecord,
  WireBundle,
  resolveBundleAssignment,
  resolveConfigForVessel,
} from '../logic/bundle';

function scopeFromRow(row: { scopeType: string; vesselId: string | null; groupTag: string | null }): Scope {
  const type = row.scopeType as ScopeType;
  if (type === 'vessel') return { type, key: row.vesselId ?? undefined };
  if (type === 'group') return { type, key: row.groupTag ?? undefined };
  return { type: 'fleet' };
}

export type VesselConfigStatus = 'unassigned' | 'pendingSync' | 'synced' | 'outOfDate';

@Injectable()
export class ConfigBundleService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Builds the live snapshot a Publish call would capture right now: the
   * latest version of every known schema, every scope's field-policy
   * overrides for those (name, version) pairs, and every scope's
   * regulatory-profile/cadence/severity rows (all scopes, unfiltered — the
   * per-vessel filtering happens later, at resolve time).
   */
  async compose(): Promise<ComposedBundleContent> {
    const allSchemaVersions = await this.db
      .select()
      .from(schema.schemaVersions)
      .orderBy(desc(schema.schemaVersions.publishedAt));
    const latestByName = new Map<string, (typeof allSchemaVersions)[number]>();
    for (const sv of allSchemaVersions) {
      if (!latestByName.has(sv.schemaName)) latestByName.set(sv.schemaName, sv);
    }
    const schemaVersionRefs = [...latestByName.values()].map((sv) => ({
      schemaName: sv.schemaName,
      version: sv.version,
      id: sv.id,
    }));

    const fieldPolicyRows = await this.db.select().from(schema.fieldPolicyAssignments);
    const fieldPolicies: FieldPolicyAssignment[] = fieldPolicyRows
      .filter((r) => latestByName.get(r.schemaName)?.version === r.schemaVersion)
      .map((r) => ({
        scope: scopeFromRow(r),
        schemaName: r.schemaName,
        schemaVersion: r.schemaVersion,
        policy: r.policy as Record<string, string>,
        prefill: r.prefill as Record<string, string>,
        events: r.events as Record<string, string[]>,
      }));

    const profileRows = await this.db.select().from(schema.regulatoryProfileAssignments);
    const regulatoryProfiles: ProfileAssignment[] = profileRows.map((r) => ({
      scope: scopeFromRow(r),
      profiles: r.profiles as string[],
    }));

    const cadenceRows = await this.db.select().from(schema.cadenceRules);
    const cadenceRules: CadenceRule[] = cadenceRows.map((r) => ({
      scope: scopeFromRow(r),
      minReportIntervalHours: r.minReportIntervalHours,
      maxGapHours: r.maxGapHours,
    }));

    const severityRows = await this.db.select().from(schema.ruleSeverityAssignments);
    const ruleSeverities: RuleSeverityAssignment[] = severityRows.map((r) => ({
      scope: scopeFromRow(r),
      severities: r.severities as Record<string, string>,
    }));

    return {
      schemaVersions: schemaVersionRefs,
      fieldPolicies,
      regulatoryProfiles,
      cadenceRules,
      ruleSeverities,
      defaultRoleNames: [],
    };
  }

  private counts(content: ComposedBundleContent) {
    return {
      schemaVersions: content.schemaVersions.length,
      fieldPolicies: content.fieldPolicies.length,
      regulatoryProfiles: content.regulatoryProfiles.length,
      cadenceRules: content.cadenceRules.length,
      ruleSeverities: content.ruleSeverities.length,
    };
  }

  /** Dry-run: what Publish would capture right now, without inserting anything. */
  async preview() {
    const content = await this.compose();
    return { counts: this.counts(content) };
  }

  async publish(label: string) {
    const content = await this.compose();
    const inserted = await this.db
      .insert(schema.configBundles)
      .values({
        label: label || '',
        schemaVersions: content.schemaVersions,
        fieldPolicies: content.fieldPolicies,
        regulatoryProfiles: content.regulatoryProfiles,
        cadenceRules: content.cadenceRules,
        ruleSeverities: content.ruleSeverities,
        defaultRoleNames: content.defaultRoleNames,
        publishedAt: new Date().toISOString(),
        publishedBy: 'System Admin',
      })
      .returning();
    return this.toSummary(inserted[0]);
  }

  /**
   * Every bundle. Kept unpaginated because the assignment picker needs the
   * full set to resolve a bundle by id — paginating it here would make
   * that picker silently omit older bundles.
   */
  async list() {
    const rows = await this.db.select().from(schema.configBundles).orderBy(desc(schema.configBundles.publishedAt));
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * One page of publish history, newest first — the same keyset seek on
   * (publishedAt, id) the check-in log uses, for the same reason: a new
   * publish lands at the top and would shift an offset under the reader.
   *
   * Separate from list() rather than a parameter on it, so the picker
   * above cannot accidentally inherit a page limit.
   */
  async history(limit = 25, cursor?: { publishedAt: string; id: string }) {
    const rows = await this.db
      .select()
      .from(schema.configBundles)
      .where(
        cursor
          ? or(
              lt(schema.configBundles.publishedAt, cursor.publishedAt),
              and(eq(schema.configBundles.publishedAt, cursor.publishedAt), lt(schema.configBundles.id, cursor.id)),
            )
          : undefined,
      )
      .orderBy(desc(schema.configBundles.publishedAt), desc(schema.configBundles.id))
      .limit(Math.min(Math.max(1, limit), 200));
    return rows.map((r) => this.toSummary(r));
  }

  private toSummary(row: typeof schema.configBundles.$inferSelect) {
    return {
      id: row.id,
      label: row.label,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      counts: {
        schemaVersions: (row.schemaVersions as unknown[]).length,
        fieldPolicies: (row.fieldPolicies as unknown[]).length,
        regulatoryProfiles: (row.regulatoryProfiles as unknown[]).length,
        cadenceRules: (row.cadenceRules as unknown[]).length,
        ruleSeverities: (row.ruleSeverities as unknown[]).length,
      },
    };
  }

  async assign(scope: Scope, bundleId: string) {
    validateScope(scope);
    const bundleRows = await this.db
      .select()
      .from(schema.configBundles)
      .where(eq(schema.configBundles.id, bundleId))
      .limit(1);
    if (bundleRows.length === 0) throw new NotFoundException('bundle not found');

    const conditions = this.scopeConditions(schema.bundleAssignments, scope);
    const existing = await this.db
      .select()
      .from(schema.bundleAssignments)
      .where(and(...conditions))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(schema.bundleAssignments)
        .set({ bundleId, assignedAt: new Date().toISOString() })
        .where(and(...conditions));
    } else {
      await this.db.insert(schema.bundleAssignments).values({
        scopeType: scope.type,
        vesselId: scope.type === 'vessel' ? scope.key ?? null : null,
        groupTag: scope.type === 'group' ? scope.key ?? null : null,
        bundleId,
        assignedAt: new Date().toISOString(),
      });
    }

    return {
      scope,
      bundleId,
      bundleLabel: bundleRows[0].label,
      publishedAt: bundleRows[0].publishedAt,
    };
  }

  async listAssignments() {
    const rows = await this.db
      .select({
        scopeType: schema.bundleAssignments.scopeType,
        vesselId: schema.bundleAssignments.vesselId,
        groupTag: schema.bundleAssignments.groupTag,
        bundleId: schema.bundleAssignments.bundleId,
        assignedAt: schema.bundleAssignments.assignedAt,
        bundleLabel: schema.configBundles.label,
        bundlePublishedAt: schema.configBundles.publishedAt,
      })
      .from(schema.bundleAssignments)
      .leftJoin(schema.configBundles, eq(schema.bundleAssignments.bundleId, schema.configBundles.id));

    return rows.map((r) => ({
      scope: scopeFromRow(r),
      bundleId: r.bundleId,
      bundleLabel: r.bundleLabel,
      publishedAt: r.bundlePublishedAt,
      assignedAt: r.assignedAt,
    }));
  }

  /** Fleet-wide "vessel configs" dashboard: assigned bundle vs. what a vessel last reported running. */
  async vesselConfigs() {
    const vesselRows = await this.db.select().from(schema.vessels);
    const assignmentRows = await this.db.select().from(schema.bundleAssignments);
    const assignments: BundleAssignmentRecord[] = assignmentRows.map((r) => ({
      scope: scopeFromRow(r),
      bundleId: r.bundleId,
    }));
    const bundleRows = await this.db.select().from(schema.configBundles);
    const bundlesById = new Map(bundleRows.map((b) => [b.id, b]));
    const syncRows = await this.db.select().from(schema.vesselSyncStatus);
    const syncByVessel = new Map(syncRows.map((s) => [s.vesselId, s]));

    return vesselRows.map((v) => {
      const groups = (v.groups as string[]) ?? [];
      const winner = resolveBundleAssignment(assignments, v.id, groups);
      const bundle = winner ? bundlesById.get(winner.bundleId) : undefined;
      const sync = syncByVessel.get(v.id);

      // appliedBundleId is now what the *vessel* reports holding, not what
      // office resolved for it. Office used to write its own resolution
      // here and then compare it against itself, so this could only ever
      // say "synced" whenever the assignment had not changed since the
      // last check-in — including for a vessel that received the bundle
      // and refused it (an unreadable wire version, a failed write), which
      // is precisely the case an operator needs to see.
      let status: VesselConfigStatus = 'unassigned';
      if (winner && bundle) {
        if (!sync || !sync.appliedBundleId) status = 'pendingSync';
        else if (sync.appliedBundleId === bundle.id) status = 'synced';
        else status = 'outOfDate';
      }

      return {
        vesselId: v.id,
        vesselName: v.name,
        imo: v.imo,
        status,
        // Needed so callers can tie a vessel's real state back to a specific
        // bundle row — the publish history could only ever say "assigned"
        // without it, which is why it showed a hardcoded "pending" forever.
        assignedBundleId: bundle?.id ?? null,
        assignedBundleLabel: bundle?.label || null,
        appliedBundleId: sync?.appliedBundleId || null,
        activeSince: sync?.lastSeenAt ?? null,
        // What the ship calls itself on its own check-ins. enroll matches by
        // IMO and keeps office's name, so these can diverge permanently and
        // nothing surfaced it until now.
        reportedName: sync?.reportedName ?? null,
        reportedImo: sync?.reportedImo ?? null,
        nameMismatch: !!sync?.reportedName && sync.reportedName !== v.name,
        imoMismatch: !!sync?.reportedImo && sync.reportedImo !== v.imo,
      };
    });
  }

  /**
   * Check-in history, newest first, optionally for one vessel. Joined to
   * `vessels` with a LEFT join on purpose: rows from vessels office does not
   * know are the most diagnostic ones in the table and must not be dropped.
   */
  /**
   * One page of the shore-side check-in log, newest first.
   *
   * Keyset-paginated on (receivedAt, id), not offset. This table takes an
   * insert on every vessel's check-in — every 30 seconds, per vessel — so
   * by the time a reader asks for the next page, OFFSET n has shifted:
   * rows already seen reappear on the following page and rows in between
   * are skipped entirely. Seeking past the last row read is immune to
   * that, because it names a position in the data rather than a count of
   * rows to discard.
   *
   * id breaks ties on receivedAt: the timestamp is not unique (a fleet
   * checking in together lands several rows on the same instant), and
   * without a tiebreaker the sort order is unstable and the seek can
   * straddle a group of equal timestamps.
   *
   * The prior implementation also capped the *reachable* history rather
   * than the page: callers raised `limit` to read further and silently
   * saw nothing past row 200 of several thousand.
   */
  /**
   * Shared WHERE for the check-in log and its metrics, so the numbers
   * always describe exactly the rows the list is showing. Computing them
   * from two different filter expressions is how a summary starts
   * disagreeing with the table under it.
   */
  private syncHistoryConditions(filters: SyncHistoryFilters) {
    const conditions: (SQL | undefined)[] = [
      filters.vesselId ? eq(schema.syncRuns.vesselId, filters.vesselId) : undefined,
      filters.outcomes?.length ? inArray(schema.syncRuns.outcome, filters.outcomes) : undefined,
      filters.from ? gte(schema.syncRuns.receivedAt, filters.from) : undefined,
      filters.to ? lte(schema.syncRuns.receivedAt, filters.to) : undefined,
      filters.bundleId ? eq(schema.syncRuns.resolvedBundleId, filters.bundleId) : undefined,
    ];

    if (filters.search) {
      // Matched against the ship's own reported identity as well as the
      // shore-authored name: a vessel office cannot resolve has no
      // knownVesselName at all, and those are the rows most worth finding.
      const term = `%${filters.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(
          ilike(schema.vessels.name, term),
          ilike(schema.syncRuns.reportedName, term),
          ilike(schema.syncRuns.reportedImo, term),
          ilike(schema.vessels.imo, term),
        ),
      );
    }
    return conditions.filter((c): c is SQL => c !== undefined);
  }

  /**
   * The check-in log — ports ovl/office's sync history view, extended
   * with the filters and ordering the screen needs to be usable on a
   * fleet rather than a demo.
   *
   * Keyset paginated on (receivedAt, id), not OFFSET: check-ins arrive
   * continuously, so an offset page silently repeats or skips rows as
   * new ones land above it.
   */
  async syncHistory(
    filters: SyncHistoryFilters = {},
    limit = 50,
    cursor?: { receivedAt: string; id: string },
    sort: SyncHistorySort = 'newest',
  ) {
    const oldestFirst = sort === 'oldest';
    // The cursor comparison has to follow the sort, not the other way
    // round. Paging an ascending list with a descending comparison walks
    // backwards off the first page and returns nothing.
    const seek = cursor
      ? oldestFirst
        ? or(
            gt(schema.syncRuns.receivedAt, cursor.receivedAt),
            and(eq(schema.syncRuns.receivedAt, cursor.receivedAt), gt(schema.syncRuns.id, cursor.id)),
          )
        : or(
            lt(schema.syncRuns.receivedAt, cursor.receivedAt),
            and(eq(schema.syncRuns.receivedAt, cursor.receivedAt), lt(schema.syncRuns.id, cursor.id)),
          )
      : undefined;

    const rows = await this.db
      .select({
        id: schema.syncRuns.id,
        runId: schema.syncRuns.runId,
        vesselId: schema.syncRuns.vesselId,
        receivedAt: schema.syncRuns.receivedAt,
        outcome: schema.syncRuns.outcome,
        resolvedBundleId: schema.syncRuns.resolvedBundleId,
        resolvedBundleVersion: schema.syncRuns.resolvedBundleVersion,
        reportedName: schema.syncRuns.reportedName,
        reportedImo: schema.syncRuns.reportedImo,
        note: schema.syncRuns.note,
        knownVesselName: schema.vessels.name,
        knownVesselImo: schema.vessels.imo,
      })
      .from(schema.syncRuns)
      .leftJoin(schema.vessels, eq(schema.syncRuns.vesselId, schema.vessels.id))
      .where(and(...this.syncHistoryConditions(filters), seek))
      .orderBy(
        oldestFirst ? asc(schema.syncRuns.receivedAt) : desc(schema.syncRuns.receivedAt),
        oldestFirst ? asc(schema.syncRuns.id) : desc(schema.syncRuns.id),
      )
      .limit(Math.min(Math.max(1, limit), 200));

    return rows.map((r) => ({
      ...r,
      // Normalised at the boundary, not passed through: the screen calls
      // new Date() on this, and Postgres's own rendering is not ISO-8601
      // — Safari rejects it and every row reads "Invalid Date".
      receivedAt: toIso(r.receivedAt),
      // The ship's own name is the only label available for a vessel office
      // cannot resolve, which is exactly when a label matters most.
      displayName: r.knownVesselName ?? r.reportedName ?? 'Unknown vessel',
      nameMismatch: !!r.knownVesselName && !!r.reportedName && r.knownVesselName !== r.reportedName,
      imoMismatch: !!r.knownVesselImo && !!r.reportedImo && r.knownVesselImo !== r.reportedImo,
      // Whether this check-in did what it was supposed to. 'served' is the
      // only wholly good outcome; the screen colours and filters on this
      // rather than re-deriving the rule per call site.
      healthy: r.outcome === 'served',
    }));
  }

  /**
   * Aggregates over the *same* filtered set the log is showing, computed
   * in SQL rather than by counting a page in Node — the page is at most
   * 200 rows and the answer has to describe every match, not the slice
   * currently on screen.
   */
  async syncMetrics(filters: SyncHistoryFilters = {}) {
    const conditions = this.syncHistoryConditions(filters);

    const [totals] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        vessels: sql<number>`count(distinct ${schema.syncRuns.vesselId})::int`,
        firstAt: sql<string | null>`min(${schema.syncRuns.receivedAt})`,
        lastAt: sql<string | null>`max(${schema.syncRuns.receivedAt})`,
        served: sql<number>`count(*) filter (where ${schema.syncRuns.outcome} = 'served')::int`,
      })
      .from(schema.syncRuns)
      .leftJoin(schema.vessels, eq(schema.syncRuns.vesselId, schema.vessels.id))
      .where(and(...conditions));

    // One grouped query rather than a count per outcome: the set of
    // outcomes is open (a new one can be recorded without this code
    // changing), so asking the data what exists beats hardcoding a list.
    //
    // Deliberately ignores the outcome filter while honouring every other
    // one. This breakdown drives the filter controls themselves, and the
    // only useful question there is "how many rows would each outcome
    // give me" — counting within the current selection makes every
    // unselected outcome read as zero the moment one is picked, so the
    // controls claim there is nothing to switch to.
    const { outcomes: _ignored, ...withoutOutcome } = filters;
    const byOutcomeRows = await this.db
      .select({ outcome: schema.syncRuns.outcome, count: sql<number>`count(*)::int` })
      .from(schema.syncRuns)
      .leftJoin(schema.vessels, eq(schema.syncRuns.vesselId, schema.vessels.id))
      .where(and(...this.syncHistoryConditions(withoutOutcome)))
      .groupBy(schema.syncRuns.outcome)
      .orderBy(desc(sql`count(*)`));

    // Per-vessel breakdown, worst first: the fleet view's real question is
    // "which ships are failing", and sorting by failure count answers it
    // directly instead of making someone scan a log for patterns.
    const perVessel = await this.db
      .select({
        vesselId: schema.syncRuns.vesselId,
        knownVesselName: schema.vessels.name,
        reportedName: sql<string | null>`max(${schema.syncRuns.reportedName})`,
        total: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${schema.syncRuns.outcome} <> 'served')::int`,
        lastAt: sql<string>`max(${schema.syncRuns.receivedAt})`,
      })
      .from(schema.syncRuns)
      .leftJoin(schema.vessels, eq(schema.syncRuns.vesselId, schema.vessels.id))
      .where(and(...conditions))
      .groupBy(schema.syncRuns.vesselId, schema.vessels.name)
      .orderBy(desc(sql`count(*) filter (where ${schema.syncRuns.outcome} <> 'served')`), desc(sql`max(${schema.syncRuns.receivedAt})`))
      .limit(SYNC_METRICS_VESSEL_LIMIT);

    const total = totals?.total ?? 0;
    return {
      total,
      vessels: totals?.vessels ?? 0,
      firstAt: toIsoOrNull(totals?.firstAt),
      lastAt: toIsoOrNull(totals?.lastAt),
      served: totals?.served ?? 0,
      failed: total - (totals?.served ?? 0),
      // Rounded to a whole percent: this is a health indicator on a
      // dashboard, not a statistic anyone reconciles to three decimals.
      successRate: total === 0 ? null : Math.round(((totals?.served ?? 0) / total) * 100),
      byOutcome: byOutcomeRows,
      perVessel: perVessel.map((v) => ({
        ...v,
        lastAt: toIso(v.lastAt),
        displayName: v.knownVesselName ?? v.reportedName ?? 'Unknown vessel',
      })),
    };
  }

  /**
   * The outcomes actually present, so the screen can build its filter
   * controls from the data instead of a hardcoded list that silently
   * omits any outcome added later.
   */
  async syncOutcomes(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ outcome: schema.syncRuns.outcome })
      .from(schema.syncRuns)
      .orderBy(asc(schema.syncRuns.outcome));
    return rows.map((r) => r.outcome);
  }

  /** Real config resolution for one vessel — backs sync.pullConfig. */
  async resolveForVessel(vesselId: string): Promise<WireBundle | null> {
    const vesselRows = await this.db.select().from(schema.vessels).where(eq(schema.vessels.id, vesselId)).limit(1);
    const vessel = vesselRows[0];
    if (!vessel) return null;
    const vesselGroups = (vessel.groups as string[]) ?? [];

    const assignmentRows = await this.db.select().from(schema.bundleAssignments);
    const assignments: BundleAssignmentRecord[] = assignmentRows.map((r) => ({
      scope: scopeFromRow(r),
      bundleId: r.bundleId,
    }));
    const winner = resolveBundleAssignment(assignments, vesselId, vesselGroups);
    if (!winner) return null;

    const bundleRows = await this.db
      .select()
      .from(schema.configBundles)
      .where(eq(schema.configBundles.id, winner.bundleId))
      .limit(1);
    const bundle = bundleRows[0];
    if (!bundle) return null;

    const content: ComposedBundleContent = {
      schemaVersions: bundle.schemaVersions as ComposedBundleContent['schemaVersions'],
      fieldPolicies: bundle.fieldPolicies as ComposedBundleContent['fieldPolicies'],
      regulatoryProfiles: bundle.regulatoryProfiles as ComposedBundleContent['regulatoryProfiles'],
      cadenceRules: bundle.cadenceRules as ComposedBundleContent['cadenceRules'],
      ruleSeverities: bundle.ruleSeverities as ComposedBundleContent['ruleSeverities'],
      defaultRoleNames: bundle.defaultRoleNames as string[],
    };

    return resolveConfigForVessel(bundle.id, bundle.cursor ?? 0, bundle.publishedAt, content, vesselId, vesselGroups);
  }

  private scopeConditions(table: { scopeType: any; vesselId: any; groupTag: any }, scope: Scope) {
    const conditions = [eq(table.scopeType, scope.type)];
    if (scope.type === 'group' && scope.key) conditions.push(eq(table.groupTag, scope.key));
    if (scope.type === 'vessel' && scope.key) conditions.push(eq(table.vesselId, scope.key));
    return conditions;
  }
}
