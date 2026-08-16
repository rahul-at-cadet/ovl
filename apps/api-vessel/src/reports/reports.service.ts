import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';
import { randomUUID } from 'crypto';

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

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: BetterSQLite3Database<typeof schema>,
  ) {}

  createReport(dto: CreateReportDto, username: string) {
    const reportId = randomUUID();
    const versionNo = 1;
    const now = new Date().toISOString();

    const report = {
      reportId,
      versionNo,
      schemaName: dto.schemaName,
      eventType: dto.eventType,
      eventTime: dto.eventTime,
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

    return this.db.transaction((tx) => {
      tx.insert(schema.reports).values(report).run();
      tx.insert(schema.reportEvents).values(event).run();

      return report;
    });
  }

  async listReports(schemaName?: string) {
    // Return the latest versions of reports for a given schema
    // In SQLite, we can just group by reportId or filter. For simplicity, we just fetch all drafts/ready for now
    if (!schemaName) {
      return this.db.query.reports.findMany({
        orderBy: (reports, { desc }) => [desc(reports.updatedAt)],
      });
    }
    
    return this.db.query.reports.findMany({
      where: eq(schema.reports.schemaName, schemaName),
      orderBy: (reports, { desc }) => [desc(reports.updatedAt)],
    });
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

  async saveSection(reportId: string, dto: SaveSectionDto, username: string) {
    const report = await this.getReport(reportId);

    if (report.state !== 'draft' && report.state !== 'ready') {
      throw new ConflictException(
        `Report is ${report.state} and cannot be edited. Start a correction.`,
      );
    }

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
    const now = new Date().toISOString();

    return this.db.transaction((tx) => {
      tx.update(schema.reports)
        .set({
          fields: mergedFields,
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
        updatedAt: now,
        state: 'draft',
      };
    });
  }

  async submitReport(reportId: string, username: string) {
    const report = await this.getReport(reportId);

    if (report.state !== 'draft' && report.state !== 'ready') {
      throw new ConflictException(`Report is already ${report.state}`);
    }

    const now = new Date().toISOString();

    return this.db.transaction((tx) => {
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
          type: 'submitted',
          at: now,
          actor: username,
        })
        .run();

      // We enqueue to the outbox to be pushed to the shore Office
      tx.insert(schema.syncOutbox)
        .values({
          id: randomUUID(),
          eventType: 'report_submitted',
          payload: JSON.stringify({ ...report, submittedBy: username, submittedAt: now, eventType: 'ReportSubmitted' }),
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
}
