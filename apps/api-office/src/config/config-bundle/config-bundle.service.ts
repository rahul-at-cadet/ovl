import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../../database/database.module';
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

  async list() {
    const rows = await this.db.select().from(schema.configBundles).orderBy(desc(schema.configBundles.publishedAt));
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
  async syncHistory(vesselId?: string, limit = 50) {
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
      })
      .from(schema.syncRuns)
      .leftJoin(schema.vessels, eq(schema.syncRuns.vesselId, schema.vessels.id))
      .where(vesselId ? eq(schema.syncRuns.vesselId, vesselId) : undefined)
      .orderBy(desc(schema.syncRuns.receivedAt))
      .limit(Math.min(limit, 200));

    return rows.map((r) => ({
      ...r,
      // The ship's own name is the only label available for a vessel office
      // cannot resolve, which is exactly when a label matters most.
      displayName: r.knownVesselName ?? r.reportedName ?? 'Unknown vessel',
      nameMismatch: !!r.knownVesselName && !!r.reportedName && r.knownVesselName !== r.reportedName,
    }));
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
