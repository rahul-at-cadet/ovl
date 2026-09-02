'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Badge } from '@ovl/ui/components/badge';
import { ChevronRight, Building2, Ship } from 'lucide-react';
import { trpc } from '@/lib/trpc';

/**
 * Report audit trail and version history — ports design handoff B4's
 * Audit trail tab (ovl/web/office/src/screens/reports/ReportDetailScreen).
 *
 * Neither existed in this port. The detail page read one 'submitted' row
 * to get an author name, so a reviewer could see a report's current state
 * but nothing about how it got there: who changed what, when, and whether
 * a change came from the ship or from shore. For a record that exists to
 * be audited, that is the part that matters.
 */

const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  correction_started: 'Correction started',
  invalidated: 'Invalidated',
  remarked: 'Remarked',
  reviewed: 'Reviewed',
};

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Field-level diff between consecutive versions. Comparison is on the
 * rendered string rather than the raw value: these come back as JSON, so
 * a number that arrives as 12 in one version and "12" in the next is the
 * same reading and should not be reported as a change.
 */
function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { field: string; from: string; to: string }[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { field: string; from: string; to: string }[] = [];
  for (const k of keys) {
    const from = formatValue(before[k]);
    const to = formatValue(after[k]);
    if (from !== to) out.push({ field: k, from, to });
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}

export function AuditTrail({ reportId, vesselId }: { reportId: string; vesselId?: string }) {
  const { data: events = [], isLoading: eventsLoading } = trpc.reports.listEvents.useQuery({ reportId, vesselId });
  const { data: versions = [], isLoading: versionsLoading } = trpc.reports.listVersions.useQuery({ reportId, vesselId });
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      <Card className="rounded-md border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle>Audit Trail</CardTitle>
          <CardDescription>
            Every recorded event for this report, oldest first — and whether it came from the vessel or from shore.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {eventsLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading trail…</p>
          ) : events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No audit events recorded for this report.
            </p>
          ) : (
            <ol className="relative space-y-0">
              {events.map((e, i) => (
                <li key={`${e.versionNo}-${e.at}-${i}`} className="relative flex gap-3 pb-5 last:pb-0">
                  {/* Continuous rail behind the markers, stopped short on
                      the final entry so the line doesn't dangle. */}
                  {i < events.length - 1 ? (
                    <span aria-hidden className="absolute left-[0.6875rem] top-6 bottom-0 w-px bg-border" />
                  ) : null}
                  <span
                    className={`relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ${
                      e.origin === 'office'
                        ? 'border-status-info/30 bg-status-info/10 text-status-info'
                        : 'border-border bg-muted text-muted-foreground'
                    }`}
                    title={e.origin === 'office' ? 'Recorded by office' : 'Reported by the vessel'}
                  >
                    {e.origin === 'office' ? <Building2 className="size-3" /> : <Ship className="size-3" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-foreground">
                        {EVENT_LABEL[e.type] ?? e.type}
                      </span>
                      <Badge variant="outline" className="bg-muted/50 text-[0.65rem]">
                        v{e.versionNo}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {e.actor ? <span className="text-foreground">{e.actor}</span> : 'System'}
                      <span> · {e.origin === 'office' ? 'shore' : 'vessel'}</span>
                    </p>
                    {e.detail && Object.keys(e.detail as object).length > 0 ? (
                      <pre className="mt-1.5 overflow-x-auto rounded border border-border bg-muted/40 p-2 text-[0.65rem] text-muted-foreground">
                        {JSON.stringify(e.detail, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-md border-border bg-card">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle>Version History</CardTitle>
          <CardDescription>
            Each correction as its own version. Expand one to see exactly which fields it changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {versionsLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading versions…</p>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No versions found.</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {versions.map((v, i) => {
                const previous = i > 0 ? versions[i - 1] : null;
                const changes = previous
                  ? diffFields(
                      previous.fields as Record<string, unknown>,
                      v.fields as Record<string, unknown>,
                    )
                  : [];
                const isOpen = expanded === v.versionNo;
                return (
                  <div key={v.versionNo}>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : v.versionNo)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                    >
                      <ChevronRight
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          Version {v.versionNo}
                          {i === versions.length - 1 ? (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">current</span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {v.state} · {v.receivedAt ? new Date(v.receivedAt).toLocaleString() : 'unknown time'}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {previous
                          ? `${changes.length} field${changes.length === 1 ? '' : 's'} changed`
                          : 'original'}
                      </span>
                    </button>

                    {isOpen ? (
                      <div className="border-t border-border bg-muted/20 px-3 py-3">
                        {!previous ? (
                          <p className="text-xs text-muted-foreground">
                            The first submitted version — there is nothing before it to compare against.
                          </p>
                        ) : changes.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            No field values differ from version {previous.versionNo}.
                          </p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="pb-1.5 pr-4 font-semibold">Field</th>
                                  <th className="pb-1.5 pr-4 font-semibold">From</th>
                                  <th className="pb-1.5 font-semibold">To</th>
                                </tr>
                              </thead>
                              <tbody>
                                {changes.map((c) => (
                                  <tr key={c.field} className="border-t border-border/60">
                                    <td className="py-1.5 pr-4 font-medium text-foreground">{c.field}</td>
                                    <td className="py-1.5 pr-4 font-mono text-status-critical/90">{c.from}</td>
                                    <td className="py-1.5 font-mono text-status-ok">{c.to}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
