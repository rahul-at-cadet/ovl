import { Injectable, BadRequestException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { Scope, ScopeType, validateScope } from '../logic/scope';
import {
  ALL_PROFILES,
  OVERRIDABLE_RULE_IDS,
  HARD_RULE_IDS,
  DEFAULT_MIN_REPORT_INTERVAL_HOURS,
  DEFAULT_MAX_GAP_HOURS,
} from '../logic/compliance';

function scopeFromRow(row: { scopeType: string; vesselId: string | null; groupTag: string | null }): Scope {
  const type = row.scopeType as ScopeType;
  if (type === 'vessel') return { type, key: row.vesselId ?? undefined };
  if (type === 'group') return { type, key: row.groupTag ?? undefined };
  return { type: 'fleet' };
}

@Injectable()
export class ComplianceService {
  constructor(
    private readonly tenantDb: TenantDbService,
  ) {}

  ruleCatalog() {
    return { overridable: [...OVERRIDABLE_RULE_IDS], hard: [...HARD_RULE_IDS] };
  }

  // ---- Regulatory profiles ----

  async listProfiles() {
    return this.tenantDb.withTenant(async (db) => {
      const rows = await db.select().from(schema.regulatoryProfileAssignments);
      return rows.map((r) => ({
        scope: scopeFromRow(r),
        profiles: r.profiles as string[],
        updatedAt: r.updatedAt,
      }));
  }, { readOnly: true });
  }

  async saveProfile(scope: Scope, profiles: string[]) {
    return this.tenantDb.withTenant(async (db) => {
      validateScope(scope);
      const unknown = profiles.find((p) => !(ALL_PROFILES as readonly string[]).includes(p));
      if (unknown) throw new BadRequestException(`unknown regulatory profile: ${unknown}`);
      const deduped = [...new Set(profiles)];

      const conditions = this.scopeConditions(schema.regulatoryProfileAssignments, scope);
      const existing = await db
        .select()
        .from(schema.regulatoryProfileAssignments)
        .where(and(...conditions))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(schema.regulatoryProfileAssignments)
          .set({ profiles: deduped, updatedAt: new Date().toISOString() })
          .where(and(...conditions));
      } else {
        await db.insert(schema.regulatoryProfileAssignments).values({
          scopeType: scope.type,
          vesselId: scope.type === 'vessel' ? scope.key ?? null : null,
          groupTag: scope.type === 'group' ? scope.key ?? null : null,
          profiles: deduped,
          updatedAt: new Date().toISOString(),
        });
      }
      return { scope, profiles: deduped };
  });
  }

  // ---- Cadence rules ----

  async listCadenceRules() {
    return this.tenantDb.withTenant(async (db) => {
      const rows = await db.select().from(schema.cadenceRules);
      return rows.map((r) => ({
        scope: scopeFromRow(r),
        minReportIntervalHours: r.minReportIntervalHours,
        maxGapHours: r.maxGapHours,
        updatedAt: r.updatedAt,
      }));
  }, { readOnly: true });
  }

  async saveCadenceRule(scope: Scope, minReportIntervalHours: number, maxGapHours: number) {
    return this.tenantDb.withTenant(async (db) => {
      validateScope(scope);
      if (!(minReportIntervalHours > 0)) {
        throw new BadRequestException('minReportIntervalHours must be > 0');
      }
      if (!(maxGapHours > 0)) {
        throw new BadRequestException('maxGapHours must be > 0');
      }

      const conditions = this.scopeConditions(schema.cadenceRules, scope);
      const existing = await db
        .select()
        .from(schema.cadenceRules)
        .where(and(...conditions))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(schema.cadenceRules)
          .set({ minReportIntervalHours, maxGapHours, updatedAt: new Date().toISOString() })
          .where(and(...conditions));
      } else {
        await db.insert(schema.cadenceRules).values({
          scopeType: scope.type,
          vesselId: scope.type === 'vessel' ? scope.key ?? null : null,
          groupTag: scope.type === 'group' ? scope.key ?? null : null,
          minReportIntervalHours,
          maxGapHours,
          updatedAt: new Date().toISOString(),
        });
      }
      return { scope, minReportIntervalHours, maxGapHours };
  });
  }

  cadenceDefaults() {
    return {
      minReportIntervalHours: DEFAULT_MIN_REPORT_INTERVAL_HOURS,
      maxGapHours: DEFAULT_MAX_GAP_HOURS,
    };
  }

  // ---- Rule severities ----

  async listRuleSeverities() {
    return this.tenantDb.withTenant(async (db) => {
      const rows = await db.select().from(schema.ruleSeverityAssignments);
      return rows.map((r) => ({
        scope: scopeFromRow(r),
        severities: r.severities as Record<string, string>,
        updatedAt: r.updatedAt,
      }));
  }, { readOnly: true });
  }

  async saveRuleSeverity(scope: Scope, severities: Record<string, string>) {
    return this.tenantDb.withTenant(async (db) => {
      validateScope(scope);
      for (const [ruleId, severity] of Object.entries(severities)) {
        if ((HARD_RULE_IDS as readonly string[]).includes(ruleId)) {
          throw new BadRequestException(`rule ${ruleId} has a hard, non-overridable severity`);
        }
        if (!(OVERRIDABLE_RULE_IDS as readonly string[]).includes(ruleId)) {
          throw new BadRequestException(`unknown rule id: ${ruleId}`);
        }
        if (!['error', 'warning', 'info'].includes(severity)) {
          throw new BadRequestException(`unknown severity: ${severity}`);
        }
      }

      const conditions = this.scopeConditions(schema.ruleSeverityAssignments, scope);
      const existing = await db
        .select()
        .from(schema.ruleSeverityAssignments)
        .where(and(...conditions))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(schema.ruleSeverityAssignments)
          .set({ severities, updatedAt: new Date().toISOString() })
          .where(and(...conditions));
      } else {
        await db.insert(schema.ruleSeverityAssignments).values({
          scopeType: scope.type,
          vesselId: scope.type === 'vessel' ? scope.key ?? null : null,
          groupTag: scope.type === 'group' ? scope.key ?? null : null,
          severities,
          updatedAt: new Date().toISOString(),
        });
      }
      return { scope, severities };
  });
  }

  private scopeConditions(
    table: { scopeType: any; vesselId: any; groupTag: any },
    scope: Scope,
  ) {
    const conditions = [eq(table.scopeType, scope.type)];
    if (scope.type === 'group' && scope.key) conditions.push(eq(table.groupTag, scope.key));
    if (scope.type === 'vessel' && scope.key) conditions.push(eq(table.vesselId, scope.key));
    return conditions;
  }
}
