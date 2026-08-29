import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { SchemaRegistryService } from '../reports/schema-registry.service';
import { validationConfigFor } from './config';
import { evaluateFieldRules } from './field-rules';
import { evaluatePlausibilityRules } from './plausibility';
import { evaluateContinuity } from './precheck';
import { policyStateForEvent } from './policy';
import { revalidate } from './cascade';
import { evaluateRegulatoryReadiness, ProfileReadiness } from './regulatory';
import { Finding, FieldEvents, FieldPolicy, ValidationConfig, ValidationReport } from './types';

type ReportRow = typeof schema.reports.$inferSelect;

function toRecord(fields: unknown): Record<string, unknown> {
  if (typeof fields === 'string') {
    try {
      return JSON.parse(fields);
    } catch {
      return {};
    }
  }
  return (fields as Record<string, unknown>) ?? {};
}

function toValidationReport(row: ReportRow): ValidationReport {
  return {
    reportId: row.reportId,
    versionNo: row.versionNo,
    schemaName: row.schemaName,
    eventType: row.eventType,
    eventTime: new Date(row.eventTime),
    fields: toRecord(row.fields),
  };
}

// Ports domain/state.go's State.InChain(): everything except draft and
// ready. Not an allowlist of known states on purpose — matches the
// original's exclusion-based check exactly, so it stays correct if a new
// state is ever introduced.
function isInChain(state: string): boolean {
  return state !== 'draft' && state !== 'ready';
}

@Injectable()
export class ValidationService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly schemaRegistry: SchemaRegistryService,
  ) {}

  /**
   * Ports ovl/office/httpapi (and this port's own getFieldPolicy tRPC
   * procedure — see that procedure's own comment on the ".json"-suffix
   * mismatch this normalizes) — the company config bundle's per-schema
   * field policy/prefill/events, or the "everything optional, all
   * events" default when no bundle has ever been applied.
   */
  async getFieldPolicyFor(schemaName: string): Promise<{ policy: FieldPolicy; prefill: Record<string, unknown>; events: FieldEvents }> {
    const empty = { policy: {}, prefill: {}, events: {} };
    const rows = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'config_bundle'));
    if (rows.length === 0) return empty;
    try {
      const bundle = JSON.parse(rows[0].value);
      const bareSchemaName = schemaName.replace(/\.json$/, '');
      const match = (bundle.schemas || []).find((s: any) => s.schemaName === bareSchemaName);
      if (!match) return empty;
      return { policy: match.policy || {}, prefill: match.prefill || {}, events: match.events || {} };
    } catch {
      return empty;
    }
  }

  /**
   * Every committed (non-draft, non-ready) version of every report for
   * a schema, latest version per reportId only, ordered by event time
   * ascending — ports ovl/vessel/store/reports.go's ListCommittedChain.
   * This is deliberately narrower than "every report ever": a draft is
   * incomplete, so measuring continuity against it (or flipping an
   * unfinished draft to invalidated) breaks constantly and locks the
   * officer out of their own unfinished work — the same production bug
   * the original's migration 00017 had to repair.
   */
  async getCommittedChain(schemaName: string): Promise<ValidationReport[]> {
    const rows = await this.db.query.reports.findMany({ where: eq(schema.reports.schemaName, schemaName) });
    const latestCommittedByReportId = new Map<string, ReportRow>();
    for (const row of rows) {
      if (!isInChain(row.state)) continue;
      const existing = latestCommittedByReportId.get(row.reportId);
      if (!existing || row.versionNo > existing.versionNo) latestCommittedByReportId.set(row.reportId, row);
    }
    return Array.from(latestCommittedByReportId.values())
      .map(toValidationReport)
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  }

  /** Ports ListChain — every state including drafts, latest version per reportId, for continuity-impact display only. */
  async getFullChain(schemaName: string): Promise<{ row: ReportRow; report: ValidationReport }[]> {
    const rows = await this.db.query.reports.findMany({ where: eq(schema.reports.schemaName, schemaName) });
    const latestByReportId = new Map<string, ReportRow>();
    for (const row of rows) {
      const existing = latestByReportId.get(row.reportId);
      if (!existing || row.versionNo > existing.versionNo) latestByReportId.set(row.reportId, row);
    }
    return Array.from(latestByReportId.values())
      .map((row) => ({ row, report: toValidationReport(row) }))
      .sort((a, b) => a.report.eventTime.getTime() - b.report.eventTime.getTime());
  }

  /**
   * Ports the vessel httpapi's evaluateReport — the shared 3-pass
   * evaluator behind both /check and /validate: field rules, then
   * plausibility, then continuity against the committed chain (with this
   * report's own earlier version replaced in-place, see
   * precheck.ts's evaluateContinuity).
   */
  async evaluateReport(row: ReportRow): Promise<{
    findings: Finding[];
    policy: FieldPolicy;
    events: FieldEvents;
    config: ValidationConfig;
  }> {
    const r = toValidationReport(row);
    const ovdSchema = this.schemaRegistry.getSchema(row.schemaName);
    const { policy, events } = await this.getFieldPolicyFor(row.schemaName);
    const config = validationConfigFor(row.schemaName);

    const chain = await this.getCommittedChain(row.schemaName);

    // Resolve each field's effective policy state once, so the
    // plausibility pass can skip fields the crew cannot see. Fields the
    // schema doesn't define aren't hidden by anything, so they default to
    // visible rather than being silently dropped.
    const schemaFieldsByName = new Map(ovdSchema.fields.map((f) => [f.name, f]));
    const isFieldHidden = (fieldName: string): boolean => {
      const f = schemaFieldsByName.get(fieldName);
      if (!f) return false;
      return (
        policyStateForEvent(policy, f.name, f.schemaMandatory, f.relevance, events, r.eventType) === 'hidden'
      );
    };

    const findings = [
      ...evaluateFieldRules(r, ovdSchema.fields, policy, events),
      ...evaluatePlausibilityRules(r, config, isFieldHidden),
      ...evaluateContinuity(r, chain, config),
    ];

    return { findings, policy, events, config };
  }

  async regulatoryReadinessFor(row: ReportRow, policy: FieldPolicy, events: FieldEvents): Promise<ProfileReadiness[]> {
    const r = toValidationReport(row);
    const ovdSchema = this.schemaRegistry.getSchema(row.schemaName);
    return evaluateRegulatoryReadiness(r, ovdSchema.fields, policy, events);
  }

  /**
   * Ports runCascade: re-validates the whole committed chain for a
   * schema and flips any report an error-level violation now applies to
   * into `invalidated`, recording which rules broke. No cascade window,
   * no "un-invalidate" branch — a report only leaves invalidated by being
   * superseded with a corrected version that supersedes it in the chain
   * (see cascade.ts's own comment). Returns the set of reportIds that
   * were newly (re)invalidated by this call, so the caller can decide
   * whether to enqueue a sync event for each.
   */
  async runCascade(schemaName: string): Promise<string[]> {
    const config = validationConfigFor(schemaName);
    const allRows = await this.db.query.reports.findMany({ where: eq(schema.reports.schemaName, schemaName) });

    const latestCommittedByReportId = new Map<string, ReportRow>();
    for (const row of allRows) {
      if (!isInChain(row.state)) continue;
      const existing = latestCommittedByReportId.get(row.reportId);
      if (!existing || row.versionNo > existing.versionNo) latestCommittedByReportId.set(row.reportId, row);
    }
    const committedRows = Array.from(latestCommittedByReportId.values());
    const chain = committedRows.map(toValidationReport).sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());

    const result = revalidate(chain, config);

    const now = new Date().toISOString();
    const newlyInvalidated: string[] = [];

    for (const current of committedRows) {
      const rules = result.invalidated.get(current.reportId);
      if (!rules || rules.length === 0) continue;

      const sameRules =
        current.state === 'invalidated' &&
        JSON.stringify(current.invalidatedRules ?? []) === JSON.stringify(rules);
      if (sameRules) continue;

      const invalidatedFrom = current.state === 'invalidated' ? current.invalidatedFrom : current.state;

      await this.db
        .update(schema.reports)
        .set({
          state: 'invalidated',
          invalidatedFrom,
          invalidatedRules: rules,
          updatedAt: now,
        })
        .where(and(eq(schema.reports.reportId, current.reportId), eq(schema.reports.versionNo, current.versionNo)));

      await this.db.insert(schema.reportEvents).values({
        reportId: current.reportId,
        versionNo: current.versionNo,
        type: 'invalidated',
        at: now,
        actor: '',
        detail: { brokenRules: rules, fromState: invalidatedFrom },
      });

      // Ports runCascade's "if invalidatedFrom is not draft/ready, enqueue
      // to office" — every report reaching this point is already drawn
      // from the COMMITTED chain (draft/ready excluded), so that
      // condition is always true here; office needs to learn about this
      // invalidation the same way it learns about any other version/
      // audit-event change.
      await this.db.insert(schema.syncOutbox).values({
        id: randomUUID(),
        eventType: 'report_invalidated',
        payload: JSON.stringify({
          reportId: current.reportId,
          versionNo: current.versionNo,
          brokenRules: rules,
          fromState: invalidatedFrom,
          at: now,
        }),
        createdAt: now,
      });

      newlyInvalidated.push(current.reportId);
    }

    return newlyInvalidated;
  }
}
