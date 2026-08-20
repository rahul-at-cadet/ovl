import { Injectable, Inject } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, gte, and, inArray } from 'drizzle-orm';
import * as schema from '@ovl/database';
import { DATABASE_CONNECTION } from '../database/database.module';
import { ComplianceService } from '../config/compliance/compliance.service';
import { effectiveCadence } from '../config/logic/compliance';

// "Recent" is a display concept, not spec text — the panel is a
// recency feed, not a full history browser, so both bounds below are a
// judgment call matching the original's own (ovl/office/httpapi/
// notifications.go).
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const NOTIFICATION_CAP = 50;

export interface NotificationLink {
  section: 'vessels' | 'reports';
  vesselId?: string;
  reportId?: string;
}

export interface NotificationView {
  id: string;
  category: 'overdue' | 'remark' | 'sync';
  title: string;
  message: string;
  at: string;
  read: boolean;
  link?: NotificationLink;
}

/**
 * Ports ovl/office/httpapi/notifications.go + office/store/
 * notifications.go: a read-only projection over overdue vessels, recent
 * vessel-authored chat messages, and recent report-landing activity —
 * there is no notifications table, everything here is recomputed live
 * from data that already exists elsewhere so it can never drift out of
 * sync with it. notification_read_state is the one piece of state that
 * has nowhere else to live (whether a given user has already seen a
 * given, deterministically-derived notification id).
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly complianceService: ComplianceService,
  ) {}

  async list(userId: string): Promise<NotificationView[]> {
    const now = new Date();
    const since = new Date(now.getTime() - LOOKBACK_MS);

    const vessels = await this.db.select().from(schema.vessels);
    const vesselById = new Map(vessels.map((v) => [v.id, v]));
    const cadenceRules = await this.complianceService.listCadenceRules();

    const notifications: NotificationView[] = [];
    notifications.push(...(await this.overdueNotifications(vessels, cadenceRules, now)));
    notifications.push(...(await this.remarkNotifications(vesselById, since)));
    notifications.push(...(await this.syncNotifications(vesselById, since)));

    notifications.sort((a, b) => (a.at < b.at ? 1 : -1));
    const capped = notifications.slice(0, NOTIFICATION_CAP);

    const readRows = await this.db
      .select({ notificationId: schema.notificationReadState.notificationId })
      .from(schema.notificationReadState)
      .where(eq(schema.notificationReadState.userId, userId));
    const readIds = new Set(readRows.map((r) => r.notificationId));
    for (const n of capped) {
      n.read = readIds.has(n.id);
    }
    return capped;
  }

  async markRead(userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const now = new Date().toISOString();
    await this.db
      .insert(schema.notificationReadState)
      .values(ids.map((id) => ({ userId, notificationId: id, readAt: now })))
      .onConflictDoNothing();
    return ids.length;
  }

  // A vessel with no submitted report ever has no cadence baseline to
  // measure overdue from — not flagged, rather than fabricating an
  // alarm from nothing (same "null when there's nothing to derive from"
  // rule this port already applies to the vessel-side voyage summary).
  private async overdueNotifications(
    vessels: (typeof schema.vessels.$inferSelect)[],
    cadenceRules: Awaited<ReturnType<ComplianceService['listCadenceRules']>>,
    now: Date,
  ): Promise<NotificationView[]> {
    const submittedRows = await this.db
      .select({ vesselId: schema.reportVersions.vesselId, eventTime: schema.reportVersions.eventTime })
      .from(schema.reportVersions)
      .where(eq(schema.reportVersions.state, 'submitted'));

    const lastSubmittedByVessel = new Map<string, Date>();
    for (const row of submittedRows) {
      const t = new Date(row.eventTime);
      const existing = lastSubmittedByVessel.get(row.vesselId);
      if (!existing || t > existing) lastSubmittedByVessel.set(row.vesselId, t);
    }

    const out: NotificationView[] = [];
    for (const v of vessels) {
      const last = lastSubmittedByVessel.get(v.id);
      if (!last) continue;
      const groups = (v.groups as string[]) ?? [];
      const cadence = effectiveCadence(cadenceRules, v.id, groups);
      const hoursSince = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
      if (hoursSince <= cadence.maxGapHours) continue;
      const overdueHours = hoursSince - cadence.maxGapHours;
      out.push({
        id: `overdue:${v.id}`,
        category: 'overdue',
        title: `${v.name} is overdue`,
        message: `Last report ${last.toISOString().slice(0, 16).replace('T', ' ')} UTC · overdue ${overdueHours.toFixed(0)}h`,
        at: last.toISOString(),
        read: false,
        link: { section: 'vessels', vesselId: v.id },
      });
    }
    return out;
  }

  private async remarkNotifications(
    vesselById: Map<string, typeof schema.vessels.$inferSelect>,
    since: Date,
  ): Promise<NotificationView[]> {
    const chatRows = await this.db
      .select({
        id: schema.chatMessages.id,
        vesselId: schema.chatMessages.vesselId,
        reportId: schema.chatMessages.reportId,
        sender: schema.chatMessages.sender,
        body: schema.chatMessages.body,
        sentAt: schema.chatMessages.sentAt,
      })
      .from(schema.chatMessages)
      .where(and(eq(schema.chatMessages.direction, 'vessel'), gte(schema.chatMessages.sentAt, since.toISOString())));
    if (chatRows.length === 0) return [];

    const reportIds = [...new Set(chatRows.map((c) => c.reportId))];
    const versionRows = await this.db
      .select({
        vesselId: schema.reportVersions.vesselId,
        reportId: schema.reportVersions.reportId,
        versionNo: schema.reportVersions.versionNo,
        eventType: schema.reportVersions.eventType,
      })
      .from(schema.reportVersions)
      .where(inArray(schema.reportVersions.reportId, reportIds));

    const eventTypeByReport = new Map<string, { versionNo: number; eventType: string }>();
    for (const row of versionRows) {
      const key = `${row.vesselId}:${row.reportId}`;
      const existing = eventTypeByReport.get(key);
      if (!existing || row.versionNo > existing.versionNo) {
        eventTypeByReport.set(key, { versionNo: row.versionNo, eventType: row.eventType });
      }
    }

    return chatRows.map((c) => {
      const vessel = vesselById.get(c.vesselId);
      const eventType = eventTypeByReport.get(`${c.vesselId}:${c.reportId}`)?.eventType || 'report';
      const body = c.body.length > 140 ? c.body.slice(0, 140) + '…' : c.body;
      return {
        id: `chat:${c.id}`,
        category: 'remark' as const,
        title: `Reply from ${vessel?.name ?? 'Unknown vessel'}`,
        message: `${c.sender} on ${eventType} · ${body}`,
        at: new Date(c.sentAt).toISOString(),
        read: false,
        link: { section: 'reports' as const, vesselId: c.vesselId, reportId: c.reportId },
      };
    });
  }

  private async syncNotifications(
    vesselById: Map<string, typeof schema.vessels.$inferSelect>,
    since: Date,
  ): Promise<NotificationView[]> {
    const landingRows = await this.db
      .select({ vesselId: schema.reportVersions.vesselId, receivedAt: schema.reportVersions.receivedAt })
      .from(schema.reportVersions)
      .where(gte(schema.reportVersions.receivedAt, since.toISOString()));

    const byVesselDay = new Map<string, { vesselId: string; day: string; count: number; lastReceivedAt: Date }>();
    for (const row of landingRows) {
      const receivedAt = new Date(row.receivedAt);
      const day = receivedAt.toISOString().slice(0, 10);
      const key = `${row.vesselId}:${day}`;
      const entry = byVesselDay.get(key);
      if (entry) {
        entry.count += 1;
        if (receivedAt > entry.lastReceivedAt) entry.lastReceivedAt = receivedAt;
      } else {
        byVesselDay.set(key, { vesselId: row.vesselId, day, count: 1, lastReceivedAt: receivedAt });
      }
    }

    return Array.from(byVesselDay.values()).map((entry) => {
      const vessel = vesselById.get(entry.vesselId);
      const plural = entry.count === 1 ? '' : 's';
      return {
        id: `sync:${entry.vesselId}:${entry.day}`,
        category: 'sync' as const,
        title: `${entry.count} report${plural} synced · ${vessel?.name ?? 'Unknown vessel'}`,
        message: entry.day,
        at: entry.lastReceivedAt.toISOString(),
        read: false,
        link: { section: 'reports' as const, vesselId: entry.vesselId },
      };
    });
  }
}
