'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Activity,
  Check,
  ChevronRight,
  FilePlus2,
  History,
  Pencil,
  RotateCcw,
  Send,
} from 'lucide-react';

/**
 * Report audit trail.
 *
 * Autosave writes a `section_saved` event on every tick, so a report that
 * took ten minutes to fill in produces a few hundred of them. Rendered one
 * row per event — which is what this used to do — the trail became an
 * unbounded column of near-identical "Section Saved" lines with a raw JSON
 * blob under each, and the events that actually matter (created, submitted,
 * invalidated, correction started) were buried somewhere inside it.
 *
 * Three things fix that without hiding anything, which matters because this
 * is an audit trail and discarding detail would defeat its purpose:
 *
 *  - Consecutive saves of the same section by the same actor collapse into
 *    one row carrying a count and a time span. The individual events stay
 *    one click away.
 *  - Newest first. An audit log is read to answer "what just happened",
 *    not "what happened first".
 *  - `detail` is rendered as a sentence rather than as JSON, with the raw
 *    object still available per entry for anyone reconciling against the
 *    office copy.
 */

export interface AuditEvent {
  id: number;
  versionNo: number;
  type: string;
  at: string;
  actor: string;
  detail?: Record<string, unknown> | null;
}

type Tone = 'ok' | 'warn' | 'attention' | 'critical' | 'info' | 'muted';

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  attention: 'bg-status-attention',
  critical: 'bg-status-critical',
  info: 'bg-status-info',
  muted: 'bg-border',
};

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  attention: 'text-status-attention',
  critical: 'text-status-critical',
  info: 'text-status-info',
  muted: 'text-muted-foreground',
};

/** Events that describe the report's lifecycle rather than its editing. */
const MILESTONES = new Set([
  'created',
  'submitted',
  'resubmitted',
  'correction_started',
  'invalidated',
]);

function sectionLabel(section: unknown) {
  if (typeof section !== 'string' || !section) return 'Section';
  const spaced = section.replace(/([A-Z])/g, ' $1').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function num(value: unknown) {
  return typeof value === 'number' ? value : 0;
}

function describe(event: AuditEvent): { label: string; tone: Tone; Icon: typeof Pencil } {
  const d = event.detail ?? {};
  switch (event.type) {
    case 'created':
      return { label: 'Draft created', tone: 'info', Icon: FilePlus2 };
    case 'section_saved':
      return { label: `${sectionLabel(d.section)} saved`, tone: 'muted', Icon: Pencil };
    case 'submitted':
      return { label: 'Submitted to shore', tone: 'ok', Icon: Send };
    case 'resubmitted':
      return { label: 'Resubmitted to shore', tone: 'ok', Icon: Send };
    case 'correction_started':
      return { label: 'Correction started', tone: 'attention', Icon: RotateCcw };
    case 'invalidated':
      return { label: 'Invalidated', tone: 'critical', Icon: AlertTriangle };
    case 'health_check_result': {
      const errors = num(d.errors);
      const warnings = num(d.warnings);
      return {
        label: 'Health check',
        tone: errors > 0 ? 'critical' : warnings > 0 ? 'warn' : 'ok',
        Icon: Activity,
      };
    }
    case 'finding_acknowledged':
      return {
        label: d.acknowledged === false ? 'Finding un-acknowledged' : 'Finding acknowledged',
        tone: 'warn',
        Icon: Check,
      };
    default:
      return {
        label: event.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        tone: 'muted',
        Icon: History,
      };
  }
}

/** The `detail` object as a readable sentence, or null when it adds nothing. */
function detailLine(event: AuditEvent): React.ReactNode {
  const d = event.detail ?? {};
  switch (event.type) {
    case 'health_check_result': {
      const parts = [
        { n: num(d.errors), word: 'error', tone: 'critical' as Tone },
        { n: num(d.warnings), word: 'warning', tone: 'warn' as Tone },
        { n: num(d.info), word: 'note', tone: 'info' as Tone },
      ].filter((p) => p.n > 0);
      if (parts.length === 0) return <span className={TONE_TEXT.ok}>No findings</span>;
      return parts.map((p, i) => (
        <span key={p.word}>
          {i > 0 && <span className="text-muted-foreground"> · </span>}
          <span className={TONE_TEXT[p.tone]}>
            {p.n} {p.word}
            {p.n === 1 ? '' : 's'}
          </span>
        </span>
      ));
    }
    case 'finding_acknowledged': {
      const field = typeof d.field === 'string' && d.field ? d.field : null;
      const message = typeof d.message === 'string' && d.message ? d.message : null;
      if (!field && !message) return null;
      return (
        <>
          {field && <span className="font-medium text-foreground">{field}</span>}
          {field && message && <span className="text-muted-foreground"> — </span>}
          {message}
        </>
      );
    }
    case 'correction_started':
      return d.newVersionNo ? `Opened version ${String(d.newVersionNo)}` : null;
    case 'invalidated': {
      const rules = Array.isArray(d.brokenRules) ? d.brokenRules : [];
      const from = typeof d.fromState === 'string' ? d.fromState : null;
      const bits: string[] = [];
      if (from) bits.push(`was ${from}`);
      if (rules.length) bits.push(`broken: ${rules.join(', ')}`);
      return bits.length ? bits.join(' · ') : null;
    }
    default:
      return null;
  }
}

function timeOf(at: string) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayOf(at: string) {
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One rendered row: either a single event or a collapsed run of saves. */
interface Row {
  key: string;
  events: AuditEvent[];
  head: AuditEvent;
}

/**
 * Collapses consecutive same-section saves by the same actor. Only adjacent
 * events merge, so a save that happens either side of a submit stays visible
 * as two separate episodes rather than being folded into one misleading run.
 */
function buildRows(events: AuditEvent[]): Row[] {
  const rows: Row[] = [];
  for (const event of events) {
    const previous = rows[rows.length - 1];
    const mergeable =
      previous &&
      event.type === 'section_saved' &&
      previous.head.type === 'section_saved' &&
      previous.head.actor === event.actor &&
      previous.head.versionNo === event.versionNo &&
      (previous.head.detail?.section ?? null) === (event.detail?.section ?? null) &&
      dayOf(previous.head.at) === dayOf(event.at);

    if (mergeable) {
      previous.events.push(event);
    } else {
      rows.push({ key: `e${event.id}`, events: [event], head: event });
    }
  }
  return rows;
}

function EventRow({ row }: { row: Row }) {
  const [expanded, setExpanded] = useState(false);
  const { head } = row;
  const { label, tone, Icon } = describe(head);
  const detail = detailLine(head);
  const count = row.events.length;
  // Rows are newest-first, so the run's last element is its earliest event.
  const earliest = row.events[count - 1];
  const hasMore = count > 1 || (head.detail && Object.keys(head.detail).length > 0);

  return (
    <li className="relative pl-8">
      <span
        className={`absolute -left-[0.3125rem] top-2 w-2.5 h-2.5 rounded-full ring-4 ring-card ${TONE_DOT[tone]}`}
        aria-hidden="true"
      />
      <div className="py-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Icon className={`w-3.5 h-3.5 shrink-0 self-center ${TONE_TEXT[tone]}`} aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">{label}</span>
          {count > 1 && (
            <span className="readout text-xs px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
              &times;{count}
            </span>
          )}
          <span className="readout text-xs text-muted-foreground">
            {count > 1 ? `${timeOf(earliest.at)} – ${timeOf(head.at)}` : timeOf(head.at)}
            {head.actor ? ` · ${head.actor}` : ' · system'}
          </span>
        </div>

        {detail && <p className="text-xs mt-0.5 text-muted-foreground break-words">{detail}</p>}

        {hasMore && (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 mt-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
            >
              <ChevronRight
                className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
                aria-hidden="true"
              />
              {count > 1 ? `${count} individual saves` : 'Raw detail'}
            </button>
            {expanded && (
              <div className="mt-1.5 border-l-2 border-border pl-3 space-y-1">
                {row.events.map((event) => (
                  <p key={event.id} className="readout text-xs text-muted-foreground break-all">
                    {new Date(event.at).toLocaleString()} · {JSON.stringify(event.detail ?? {})}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function AuditTimeline({
  events,
  isLoading,
}: {
  events?: AuditEvent[];
  isLoading: boolean;
}) {
  const [milestonesOnly, setMilestonesOnly] = useState(false);

  const groups = useMemo(() => {
    if (!events?.length) return [];
    const ordered = [...events]
      .filter((e) => !milestonesOnly || MILESTONES.has(e.type))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || b.id - a.id);

    // Version first, then day inside it: a correction opens a new version, so
    // that boundary is the one an officer reconciling a report looks for.
    const byVersion: { versionNo: number; days: { day: string; rows: Row[] }[] }[] = [];
    for (const event of ordered) {
      let version = byVersion[byVersion.length - 1];
      if (!version || version.versionNo !== event.versionNo) {
        version = { versionNo: event.versionNo, days: [] };
        byVersion.push(version);
      }
      const day = dayOf(event.at);
      let bucket = version.days[version.days.length - 1];
      if (!bucket || bucket.day !== day) {
        bucket = { day, rows: [] };
        version.days.push(bucket);
      }
      bucket.rows.push({ key: `e${event.id}`, events: [event], head: event });
    }
    for (const version of byVersion) {
      for (const bucket of version.days) {
        bucket.rows = buildRows(bucket.rows.map((r) => r.head));
      }
    }
    return byVersion;
  }, [events, milestonesOnly]);

  const total = events?.length ?? 0;
  const shown = groups.reduce(
    (sum, v) => sum + v.days.reduce((s, d) => s + d.rows.length, 0),
    0,
  );

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border shrink-0">
        <div
          role="group"
          aria-label="Filter events"
          className="inline-flex rounded-md border border-border overflow-hidden"
        >
          {([
            ['All activity', false],
            ['Milestones', true],
          ] as const).map(([label, value]) => (
            <button
              key={label}
              type="button"
              onClick={() => setMilestonesOnly(value)}
              aria-pressed={milestonesOnly === value}
              className={`px-3 min-h-11 text-sm whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                milestonesOnly === value
                  ? 'bg-surface-active text-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-surface-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="readout text-xs text-muted-foreground" aria-live="polite">
          {milestonesOnly ? `${shown} of ${total} events` : `${total} events`}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pt-4 max-h-[75vh]">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading events…</p>
        ) : groups.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <History className="w-8 h-8 mx-auto mb-3 opacity-50" aria-hidden="true" />
            <p className="text-sm">
              {total === 0 ? 'No events recorded yet.' : 'No milestones in this report yet.'}
            </p>
          </div>
        ) : (
          groups.map((version) => (
            <section key={`v${version.versionNo}`} className="mb-2">
              <h3 className="sticky top-0 z-20 bg-card py-1.5 text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Version {version.versionNo}
              </h3>
              {version.days.map((bucket) => (
                <div key={bucket.day}>
                  <p className="sticky top-7 z-10 bg-card readout text-xs text-muted-foreground pl-11 py-1">{bucket.day}</p>
                  <ul className="relative border-l border-border ml-[0.6875rem]">
                    {bucket.rows.map((row) => (
                      <EventRow key={row.key} row={row} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
