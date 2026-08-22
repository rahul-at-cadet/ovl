import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { randomUUID } from 'crypto';
import { TRPCError } from '@trpc/server';
import { ValidationService } from '../validation/validation.service';
import { parseEventTime } from '../validation/field-rules';
import { hasErrors } from '../validation/types';

// Architecture 12.3: "text-only, size-capped" — enforced on every write
// path on both sides (mirrors pkg/domain.MaxChatBodyBytes and the
// matching constant in api-office's trpc.router.ts), so the cap can't
// drift between the two send paths.
const MAX_CHAT_BODY_BYTES = 4096;

export type CreateReportDto = {
  schemaName: string;
  eventType: string;
  eventTime: string;
  fields: Record<string, any>;
};

export type SaveSectionDto = {
  section: string; // the frontend usually submits changes by section
  changes: Record<string, any>;
};

// Ports domain/report.go's RecomputeEventTime: when a report's fields
// carry the Date_UTC/Time_UTC pair (only log-abstract does today), the
// combined value becomes the report's EventTime — the source of truth
// the whole continuity engine chains off of. Schemas without that pair
// keep whatever eventTime was already provided.
function recomputeEventTime(fields: Record<string, any>, fallback: string): string {
  const dateUTC = fields.Date_UTC;
  const timeUTC = fields.Time_UTC;
  if (typeof dateUTC !== 'string' || typeof timeUTC !== 'string') return fallback;
  const parsed = parseEventTime(dateUTC, timeUTC);
  return parsed ? parsed.toISOString() : fallback;
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly validationService: ValidationService,
  ) {}

  async createReport(dto: CreateReportDto, username: string) {
    const reportId = randomUUID();
    const versionNo = 1;
    const now = new Date().toISOString();
    const eventTime = recomputeEventTime(dto.fields, dto.eventTime);

    const report = {
      reportId,
      versionNo,
      schemaName: dto.schemaName,
      eventType: dto.eventType,
      eventTime,
      fields: dto.fields, // better-sqlite3 handles JSON parsing if mode is 'json'
      state: 'draft',
      createdAt: now,
      createdBy: username,
      updatedAt: now,
    };

    const event = {
      reportId,
      versionNo,
      type: 'created',
      at: now,
      actor: username,
    };

    const result = this.db.transaction((tx) => {
      tx.insert(schema.reports).values(report).run();
      tx.insert(schema.reportEvents).values(event).run();

      return report;
    });

    // A brand-new draft never joins the committed chain (see
    // ValidationService.getCommittedChain's own comment on why drafts
    // are excluded), so this has no practical effect today — kept for
    // fidelity with the original, which calls runCascade
    // unconditionally after every report-chain mutation.
    await this.validationService.runCascade(dto.schemaName);

    return result;
  }

  async listReports(schemaName?: string) {
    // Every edit inserts a new (reportId, versionNo) row rather than
    // updating in place (architecture 8.1's append-only version history),
    // so a report edited more than once has multiple rows sharing the
    // same reportId here. Keeping only the highest versionNo per
    // reportId is required, not an optimization — without it the
    // frontend's reportId-keyed lists render the same report twice and
    // React logs a duplicate-key warning.
    const rows = schemaName
      ? await this.db.query.reports.findMany({
          where: eq(schema.reports.schemaName, schemaName),
          orderBy: (reports, { desc }) => [desc(reports.versionNo)],
        })
      : await this.db.query.reports.findMany({
          orderBy: (reports, { desc }) => [desc(reports.versionNo)],
        });

    const latestByReportId = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestByReportId.has(row.reportId)) {
        latestByReportId.set(row.reportId, row);
      }
    }

    return Array.from(latestByReportId.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async getReport(reportId: string) {
    const versions = await this.db.query.reports.findMany({
      where: eq(schema.reports.reportId, reportId),
      orderBy: (reports, { desc }) => [desc(reports.versionNo)],
      limit: 1,
    });

    if (versions.length === 0) {
      throw new NotFoundException('Report not found');
    }

    return versions[0];
  }

  // Ports loadEditableReport — draft/ready gate shared by every
  // still-editable-report action (saveSection, check, acknowledgeFinding).
  // Not private: AttachmentsService reuses the same draft/ready gate for
  // upload/delete (an attachment on a locked report would have nowhere
  // consistent to attribute a version to, same rule as every other
  // field mutation).
  async loadEditableReport(reportId: string) {
    const report = await this.getReport(reportId);
    if (report.state !== 'draft' && report.state !== 'ready') {
      throw new ConflictException(`report is ${report.state} and locked; start a correction to edit it`);
    }
    return report;
  }

  async saveSection(reportId: string, dto: SaveSectionDto, username: string) {
    const report = await this.loadEditableReport(reportId);

    let currentFields: Record<string, any> = {};
    if (typeof report.fields === 'string') {
      try {
        currentFields = JSON.parse(report.fields);
      } catch (e) {
        console.error("Failed to parse report fields", e);
      }
    } else if (report.fields) {
      currentFields = report.fields as Record<string, any>;
    }

    const mergedFields = {
      ...currentFields,
      ...dto.changes,
    };
    const eventTime = recomputeEventTime(mergedFields, report.eventTime);
    const now = new Date().toISOString();

    const result = this.db.transaction((tx) => {
      tx.update(schema.reports)
        .set({
          fields: mergedFields,
          eventTime,
          updatedAt: now,
          state: 'draft', // saving resets back to draft
        })
        .where(
          and(
            eq(schema.reports.reportId, reportId),
            eq(schema.reports.versionNo, report.versionNo),
          ),
        )
        .run();

      tx.insert(schema.reportEvents)
        .values({
          reportId,
          versionNo: report.versionNo,
          type: 'section_saved',
          at: now,
          actor: username,
          detail: { section: dto.section },
        })
        .run();

      return {
        ...report,
        fields: mergedFields,
        eventTime,
        updatedAt: now,
        state: 'draft',
      };
    });

    await this.validationService.runCascade(report.schemaName);
    return result;
  }

  /**
   * Submitting requires the report to have actually passed a health
   * check first (state === 'ready', set by checkReport/MarkReady below)
   * — previously any draft could submit directly with zero validation
   * ever having run. A correction's first-ever resubmit (versionNo > 1)
   * is recorded as a "resubmitted" event instead of "submitted", matching
   * domain.Report.Submit exactly; the report's `state` column is
   * "submitted" either way.
   */
  async submitReport(reportId: string, username: string) {
    const report = await this.getReport(reportId);

    if (report.state !== 'ready') {
      throw new ConflictException(
        report.state === 'draft'
          ? 'report must pass Health Check before it can be submitted'
          : `report is already ${report.state}`,
      );
    }

    const now = new Date().toISOString();
    const eventType = report.versionNo > 1 ? 'resubmitted' : 'submitted';

    const result = this.db.transaction((tx) => {
      tx.update(schema.reports)
        .set({
          state: 'submitted',
          submittedAt: now,
          submittedBy: username,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.reports.reportId, reportId),
            eq(schema.reports.versionNo, report.versionNo),
          ),
        )
        .run();

      tx.insert(schema.reportEvents)
        .values({
          reportId,
          versionNo: report.versionNo,
          type: eventType,
          at: now,
          actor: username,
        })
        .run();

      // We enqueue to the outbox to be pushed to the shore Office
      tx.insert(schema.syncOutbox)
        .values({
          id: randomUUID(),
          eventType: 'report_submitted',
          payload: JSON.stringify({ ...report, state: 'submitted', submittedBy: username, submittedAt: now }),
          createdAt: now,
        })
        .run();

      return {
        ...report,
        state: 'submitted',
        submittedAt: now,
        submittedBy: username,
      };
    });

    await this.validationService.runCascade(report.schemaName);
    return result;
  }

  /**
   * Creates version N+1 of a submitted-or-later report as a new draft
   * (architecture 8.1/8.2, design handoff A7's "Start correction") —
   * mirrors pkg/domain.Report.NewCorrection + vessel/httpapi's
   * handleStartCorrection. Same reportId, fields cloned from the current
   * version, state reset to draft. No submit-permission check: any
   * vessel user may self-initiate a correction (architecture 8.1), same
   * as any other draft edit. The correction_started event is attached to
   * the *old* version (matching NewCorrection's own event placement) and
   * separately pushed to office immediately — office already has that
   * old version and needs to know a correction started against it,
   * independent of whenever the new draft itself eventually gets
   * submitted.
   */
  async startCorrection(reportId: string, username: string) {
    const report = await this.getReport(reportId);
    if (report.state === 'draft' || report.state === 'ready') {
      throw new TRPCError({ code: 'CONFLICT', message: `Cannot correct a report in state "${report.state}"; edit it directly instead.` });
    }

    const now = new Date().toISOString();
    const newVersionNo = report.versionNo + 1;
    let currentFields: Record<string, any> = {};
    if (typeof report.fields === 'string') {
      try {
        currentFields = JSON.parse(report.fields);
      } catch {
        currentFields = {};
      }
    } else if (report.fields) {
      currentFields = report.fields as Record<string, any>;
    }

    const next = {
      reportId,
      versionNo: newVersionNo,
      schemaName: report.schemaName,
      eventType: report.eventType,
      eventTime: report.eventTime,
      fields: { ...currentFields },
      state: 'draft',
      createdAt: now,
      createdBy: username,
      updatedAt: now,
    };

    return this.db.transaction((tx) => {
      tx.insert(schema.reports).values(next).run();

      tx.insert(schema.reportEvents)
        .values({
          reportId,
          versionNo: report.versionNo,
          type: 'correction_started',
          at: now,
          actor: username,
          detail: { newVersionNo },
        })
        .run();

      tx.insert(schema.syncOutbox)
        .values({
          id: randomUUID(),
          eventType: 'correction_started',
          payload: JSON.stringify({ reportId, versionNo: report.versionNo, newVersionNo, actor: username, at: now }),
          createdAt: now,
        })
        .run();

      return next;
    });
  }

  /**
   * Ports handleCheckReport — the only path to `ready`; submit requires
   * it. Runs the full 3-pass evaluation (field rules + plausibility +
   * continuity against the committed chain), then MarkReady: any
   * error-severity finding keeps the report in `draft` (returned in the
   * response, not thrown — a failed check is a normal, expected result,
   * not a server error). Does NOT run cascade — check only reads
   * already-persisted invalidated state via continuityImpact, it never
   * recomputes it (cascade runs on create/saveSection/submit instead).
   */
  async checkReport(reportId: string, username: string) {
    const report = await this.loadEditableReport(reportId);
    const { findings, policy, events } = await this.validationService.evaluateReport(report);

    let errors = 0;
    let warnings = 0;
    let info = 0;
    for (const f of findings) {
      if (f.severity === 'error') errors++;
      else if (f.severity === 'warning') warnings++;
      else info++;
    }

    const now = new Date().toISOString();
    const nextState = errors > 0 ? 'draft' : 'ready';

    const updated = this.db.transaction((tx) => {
      tx.update(schema.reports)
        .set({ state: nextState, updatedAt: now })
        .where(and(eq(schema.reports.reportId, reportId), eq(schema.reports.versionNo, report.versionNo)))
        .run();

      // MarkReady's event has no actor in the original either — the
      // domain method that builds it doesn't take a username, only the
      // findings; a health check result belongs to the report's own
      // computed state, not to whoever happened to click the button.
      tx.insert(schema.reportEvents)
        .values({
          reportId,
          versionNo: report.versionNo,
          type: 'health_check_result',
          at: now,
          actor: '',
          detail: { errors, warnings, info },
        })
        .run();

      tx.insert(schema.syncOutbox)
        .values({
          id: randomUUID(),
          eventType: 'health_check_result',
          payload: JSON.stringify({ reportId, versionNo: report.versionNo, errors, warnings, info, at: now }),
          createdAt: now,
        })
        .run();

      return { ...report, state: nextState, updatedAt: now };
    });

    const regulatoryReadiness = await this.validationService.regulatoryReadinessFor(report, policy, events);

    const fullChain = await this.validationService.getFullChain(report.schemaName);
    const continuityImpact = fullChain
      .filter(({ row }) => row.reportId !== reportId && row.state === 'invalidated')
      .map(({ row }) => ({
        reportId: row.reportId,
        eventType: row.eventType,
        eventTime: row.eventTime,
        invalidatedRules: (row.invalidatedRules as string[] | null) ?? [],
      }));

    return { report: updated, findings, regulatoryReadiness, continuityImpact };
  }

  /**
   * Ports handleValidateReport — a stateless preview for on-blur/
   * debounced calls. No state gate (unlike checkReport): the original
   * lets this run against a report in any state, since it never writes
   * anything. Replaces `fields` wholesale with the caller's in-flight
   * values (not merged with what's persisted) and evaluates against
   * them, but does NOT recompute eventTime from the previewed
   * Date_UTC/Time_UTC — the preview lags on time-chain findings until
   * the officer actually saves, matching the original exactly.
   */
  async validateReport(reportId: string, fields: Record<string, any>) {
    const report = await this.getReport(reportId);
    const preview = { ...report, fields };
    const { findings } = await this.validationService.evaluateReport(preview);
    return { findings };
  }

  /**
   * Ports handleAcknowledgeFinding — an append-only audit trail (no
   * acknowledgements table, no read-back endpoint; the UI derives
   * current state by replaying report_events). Enqueued to the outbox
   * immediately, unlike most report events which wait for submit.
   */
  async acknowledgeFinding(
    reportId: string,
    dto: { ruleId: string; field?: string; message: string; acknowledged: boolean },
    username: string,
  ) {
    if (!dto.ruleId) {
      throw new BadRequestException('ruleId is required');
    }
    const report = await this.loadEditableReport(reportId);
    const now = new Date().toISOString();
    const detail = { ruleId: dto.ruleId, field: dto.field, message: dto.message, acknowledged: dto.acknowledged };

    this.db.transaction((tx) => {
      tx.insert(schema.reportEvents)
        .values({
          reportId,
          versionNo: report.versionNo,
          type: 'finding_acknowledged',
          at: now,
          actor: username,
          detail,
        })
        .run();

      tx.insert(schema.syncOutbox)
        .values({
          id: randomUUID(),
          eventType: 'finding_acknowledged',
          payload: JSON.stringify({ reportId, versionNo: report.versionNo, ...detail, at: now }),
          createdAt: now,
        })
        .run();
    });

    return { acknowledged: dto.acknowledged };
  }

  async listInvalidationNotices(reportId: string) {
    return this.db.query.invalidationNotices.findMany({
      where: eq(schema.invalidationNotices.reportId, reportId),
      orderBy: (n, { asc }) => [asc(n.computedAt)],
    });
  }

  async listEvents(reportId: string) {
    return this.db.query.reportEvents.findMany({
      where: eq(schema.reportEvents.reportId, reportId),
      orderBy: (events, { asc }) => [asc(events.at)],
    });
  }

  async getChat(reportId: string) {
    return this.db.query.chatMessages.findMany({
      where: eq(schema.chatMessages.reportId, reportId),
      orderBy: (messages, { asc }) => [asc(messages.sentAt)],
    });
  }

  async sendChatMessage(reportId: string, body: string, username: string) {
    if (Buffer.byteLength(body, 'utf8') > MAX_CHAT_BODY_BYTES) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Chat message body exceeds the ${MAX_CHAT_BODY_BYTES} byte limit.` });
    }
    const messageId = randomUUID();
    const now = new Date().toISOString();
    
    const message = {
      id: messageId,
      reportId,
      sender: username,
      body,
      sentAt: now,
      direction: 'ship_to_shore',
    };

    return this.db.transaction((tx) => {
      tx.insert(schema.chatMessages).values(message).run();
      
      // Enqueue sync outbox for chat message
      tx.insert(schema.syncOutbox).values({
        id: randomUUID(),
        eventType: 'chat_sent',
        payload: JSON.stringify(message),
        createdAt: now,
      }).run();
      
      return message;
    });
  }

  // Office-authored only — pulled down via sync (SyncService.applyRemarks),
  // never written locally. Read-only from the vessel's side.
  async getRemarks(reportId: string) {
    return this.db.query.remarks.findMany({
      where: eq(schema.remarks.reportId, reportId),
      orderBy: (r, { asc }) => [asc(r.createdAt)],
    });
  }
}
