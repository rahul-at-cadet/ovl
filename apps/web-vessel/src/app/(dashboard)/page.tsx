'use client';

import type { ReactNode } from 'react';
import { Button } from '@ovl/ui/components/button';
import {
  FileText,
  Plus,
  CloudOff,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  ArrowRight,
  Loader2,
  Ship,
  CircleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { trpc } from '@/lib/trpc';

/**
 * One panel style for the whole dashboard: solid surface, 1px border, a
 * ruled header. Replaces the previous mix of translucent cards, gradients and
 * blurred colour washes, which read as decoration on a screen that is meant
 * to be scanned.
 */
function Panel({
  title,
  icon: Icon,
  action,
  children,
  className = '',
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col min-h-0 border border-border bg-card rounded-sm ${className}`}>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 h-12 border-b border-border bg-card shrink-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A single label/value line that states its own absence rather than vanishing. */
function Field({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="instrument-label">{label}</p>
      <p className={`text-sm mt-1 break-words ${mono ? 'readout' : ''} ${value ? 'text-foreground' : 'text-muted-foreground'}`}>
        {value || 'Not reported'}
      </p>
    </div>
  );
}

/** Dates arrive as strings from the API; a malformed one must not blank the panel. */
function fmtDate(v: string) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function fmtDateTime(v: string) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

function Metric({
  label,
  value,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'warn' | 'ok' | 'critical';
}) {
  const toneClass =
    tone === 'warn'
      ? 'text-status-warn'
      : tone === 'ok'
        ? 'text-status-ok'
        : tone === 'critical'
          ? 'text-status-critical'
          : 'text-foreground';
  return (
    <div className="bg-surface-hover rounded-sm px-3 py-3 min-w-0 flex flex-col justify-between gap-1">
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${toneClass}`} />
        <span className="instrument-label leading-tight">{label}</span>
      </div>
      <p className={`readout text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

/** Alert boxes are tinted and ruled, never a solid field of colour. */
function Alert({
  tone,
  title,
  children,
  action,
}: {
  tone: 'critical' | 'warn';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const cls =
    tone === 'critical'
      ? 'border-status-critical/40 bg-status-critical/10 text-status-critical'
      : 'border-status-warn/40 bg-status-warn/10 text-status-warn';
  const Icon = tone === 'critical' ? CircleAlert : AlertTriangle;
  return (
    <div
      role="alert"
      className={`flex flex-col sm:flex-row sm:items-center gap-3 border rounded-sm px-4 py-3 ${cls}`}
    >
      <Icon className="w-5 h-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {children && <p className="text-sm mt-0.5 opacity-90 break-words">{children}</p>}
      </div>
      {action}
    </div>
  );
}

export default function DashboardPage() {
  const pingQuery = trpc.ping.useQuery();

  const { data: reports = [], isLoading: reportsLoading } = trpc.reports.listReports.useQuery({ schemaName: '' });
  const { data: voyage } = trpc.system.getActiveVoyage.useQuery();
  const { data: setupStatus } = trpc.setup.status.useQuery();
  const { data: syncStatus } = trpc.sync.status.useQuery();
  const { data: syncHistory = [] } = trpc.sync.history.useQuery({ limit: 8 });
  const { data: settings } = trpc.settings.get.useQuery();
  const { data: suggestions } = trpc.reports.listEventSuggestions.useQuery({ schemaName: 'log-abstract' });
  const syncNowMutation = trpc.sync.now.useMutation();

  const allInProgress = reports.filter((r) => r.state === 'draft');
  // Three, not five: the xl dashboard is one fixed-height screen and the
  // drafts list was the tallest thing competing for it. "View all" in the
  // panel header covers the rest.
  const inProgress = allInProgress.slice(0, 3);
  const recent = reports.filter((r) => r.state !== 'draft').slice(0, 4);

  let isOverdue = false;
  let overdueByStr = '';

  if (recent.length > 0 && settings?.reportingIntervalHours) {
    const lastReportTime = new Date(recent[0].createdAt).getTime();
    const now = Date.now();
    const hoursSince = (now - lastReportTime) / (1000 * 60 * 60);
    const maxGapHours = Number(settings.reportingIntervalHours) + 2; // Allow 2 hours grace period
    if (hoursSince > maxGapHours) {
      isOverdue = true;
      const overdueHours = Math.floor(hoursSince - maxGapHours);
      overdueByStr = `${overdueHours}h ${Math.floor((hoursSince - maxGapHours - overdueHours) * 60)}m`;
    }
  }

  const notEnrolled = setupStatus && !setupStatus.isConfigured;
  const online = pingQuery.isSuccess;
  const pending = syncStatus?.pendingCount ?? 0;

  return (
    // Document order is the priority order, so the small-screen stack and the
    // reading order for assistive tech are the same as the visual hierarchy.
    <div className="flex flex-col gap-4 pb-4 xl:pb-0 xl:h-[calc(100vh_-_88px)] xl:overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
        <div className="min-w-0">
          {/* The ship's own identity. It was captured during setup and then
              shown nowhere else in the app, so a crew member had no way to
              confirm which vessel this terminal was reporting as. */}
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground truncate">
            {syncStatus?.vesselName || 'Terminal Dashboard'}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {syncStatus?.imoNumber ? (
              <>
                IMO {syncStatus.imoNumber} · Local edge reporting and synchronisation.
              </>
            ) : (
              'Local edge reporting and synchronisation.'
            )}
          </p>
        </div>
        <Button
          render={<Link href="/reports/new" />}
          nativeButton={false}
          className="w-full sm:w-auto justify-center px-5"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Report
        </Button>
      </div>

      {/* 1 — urgent alerts */}
      {(notEnrolled || isOverdue || syncStatus?.lastError) && (
        <div className="flex flex-col gap-3 shrink-0">
          {isOverdue && (
            <Alert tone="critical" title="Report overdue">
              Last report was {overdueByStr} beyond the reporting interval.
            </Alert>
          )}
          {notEnrolled && (
            <Alert
              tone="warn"
              title="Not enrolled with shore"
              action={
                <Button
                  variant="outline"
                  render={<Link href="/settings" />}
                  nativeButton={false}
                  className="w-full sm:w-auto justify-center shrink-0"
                >
                  Enroll
                </Button>
              }
            >
              Reports save locally but will not reach the office until this node is enrolled.
            </Alert>
          )}
          {syncStatus?.lastError && (
            <Alert tone="warn" title="Last sync failed">
              {syncStatus.lastError}
            </Alert>
          )}
        </div>
      )}

      {/* 2 — next required report */}
      {suggestions && suggestions.length > 0 && (
        <section className="bg-card border border-border rounded-sm p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4 shrink-0">
          <div className="min-w-0 flex-1">
            <p className="instrument-label">Next required report</p>
            <p className="text-xl sm:text-2xl font-semibold text-foreground mt-1 break-words">{suggestions[0]}</p>
          </div>
          <Button
            render={<Link href="/reports/new" />}
            nativeButton={false}
            className="w-full sm:w-auto justify-center px-5 shrink-0"
          >
            Start
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </section>
      )}

      {/* 3 — report and sync health at a glance */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <Metric
          label="Drafts"
          value={allInProgress.length.toString()}
          icon={FileText}
          tone={allInProgress.length > 0 ? 'warn' : 'default'}
        />
        <Metric
          label="Queued"
          value={pending.toString()}
          icon={CloudOff}
          tone={pending > 0 ? 'warn' : 'default'}
        />
        <Metric
          label="Network"
          value={online ? 'Online' : 'Offline'}
          icon={online ? Wifi : WifiOff}
          tone={online ? 'ok' : 'critical'}
        />
        <Metric
          label="Enrolled"
          value={syncStatus?.enrolled ? 'Yes' : 'No'}
          icon={Ship}
          tone={syncStatus?.enrolled ? 'ok' : 'warn'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3 xl:flex-1 xl:min-h-0">
        {/* 4 — drafts */}
        <Panel
          title="Drafts in progress"
          icon={FileText}
          className="xl:min-h-0"
          action={
            <Button
              variant="ghost"
              size="sm"
              render={<Link href="/reports" />}
              nativeButton={false}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              View all
              <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          }
        >
          {reportsLoading ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading drafts…
            </p>
          ) : inProgress.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No active drafts. A new report saves automatically as you fill it in.
            </p>
          ) : (
            <ul className="divide-y divide-border xl:min-h-0 xl:overflow-y-auto">
              {inProgress.map((report) => (
                <li key={report.reportId}>
                  <Link
                    href={`/reports/${report.reportId}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 min-h-12 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground truncate">
                        {report.schemaName || 'Unnamed report'}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate mt-0.5">
                        Started {new Date(report.createdAt).toLocaleDateString()}
                      </span>
                    </span>
                    <StatusBadge status="draft" size="sm" className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* 5 — voyage, then recent activity. Voyage sits above the submitted
            list: it answers "where are we now", and it used to be pinned
            under the sync panel where it got squeezed to a bare header. */}
        <div className="flex flex-col gap-4 xl:min-h-0">
        {/* 6 — voyage context */}
        <Panel title="Active voyage" icon={Ship} className="xl:shrink-0 xl:max-h-64 xl:overflow-y-auto">
          {voyage ? (
            <div className="p-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
              {/* Every field on the voyage summary is optional except
                  lastReportAt (see vessel/httpapi/voyage.go's voyageSummaryView):
                  it is derived per request from whatever the vessel has actually
                  reported, so any of these can legitimately be absent. Each one
                  renders its own "not reported" state rather than the panel
                  hiding wholesale, and an unknown field arriving later cannot
                  break the layout. */}
              <Field label="Voyage number" value={voyage.voyageNumber} mono />
              {'imo' in voyage && (
                <Field label="IMO" value={(voyage as { imo?: string }).imo} mono />
              )}
              <div className="min-w-0">
                <p className="instrument-label">Passage</p>
                <p className="text-sm text-foreground mt-1 break-words">
                  {voyage.fromPort || 'Not reported'}{' '}
                  <span className="text-muted-foreground" aria-label="to">&rarr;</span>{' '}
                  {voyage.toPort || 'Not reported'}
                </p>
                {(voyage.departedAt || voyage.eta) && (
                  <p className="readout text-xs text-muted-foreground mt-0.5 break-words">
                    {voyage.departedAt ? `Dep ${fmtDate(voyage.departedAt)}` : ''}
                    {voyage.departedAt && voyage.eta ? ' \u00b7 ' : ''}
                    {voyage.eta ? `ETA ${fmtDate(voyage.eta)}` : ''}
                  </p>
                )}
              </div>
              <div className="min-w-0">
                <p className="instrument-label">Distance</p>
                <p className="readout text-sm text-foreground mt-1">
                  {voyage.distanceSailedNm != null ? `${voyage.distanceSailedNm.toFixed(0)} NM sailed` : 'Not reported'}
                </p>
                <p className="readout text-xs text-muted-foreground mt-0.5">
                  {voyage.distanceRemainingNm != null ? `${voyage.distanceRemainingNm.toFixed(0)} NM remaining` : ''}
                </p>
                {voyage.progressPercent != null && (
                  <div
                    className="mt-2 h-2 bg-muted border border-border rounded-sm overflow-hidden"
                    role="progressbar"
                    aria-valuenow={Math.round(voyage.progressPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Voyage progress"
                  >
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${Math.max(0, Math.min(100, voyage.progressPercent))}%` }}
                    />
                  </div>
                )}
              </div>
              <Field label="Position" value={voyage.position?.text} mono />
              {/* Freshness: this whole panel is only as current as the report it
                  was derived from. */}
              <Field
                label="Derived from report at"
                value={voyage.lastReportAt ? fmtDateTime(voyage.lastReportAt) : undefined}
                mono
              />
            </div>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              Voyage details appear here once a report carries voyage fields.
            </p>
          )}
        </Panel>

        {/* Recent activity, lowest priority */}
        <Panel
          title="Recently submitted"
          icon={FileText}
          className="xl:flex-1 xl:min-h-0"
          action={
            <Button
              variant="ghost"
              size="sm"
              render={<Link href="/reports" />}
              nativeButton={false}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              View all
              <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          }
        >
          {reportsLoading ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading…
            </p>
          ) : recent.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No reports submitted yet.</p>
          ) : (
            <ul className="divide-y divide-border xl:min-h-0 xl:overflow-y-auto">
              {recent.map((report) => (
                <li key={report.reportId}>
                  <Link
                    href={`/reports/${report.reportId}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 min-h-12 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground truncate">{report.schemaName}</span>
                      <span className="block text-xs text-muted-foreground truncate mt-0.5">{report.createdBy}</span>
                    </span>
                    <StatusBadge status={report.state} size="sm" className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        </div>

        {/* 6 — sync, deliberately last and least prominent: operational
            plumbing, not the reporting work this screen exists for. It
            still scrolls its own body. */}
        {/* Not shrink-0: this panel grew a config-bundle row, a name-mismatch
            alert and a run history, and the xl column is a fixed-height
            overflow-hidden container. Pinned at its natural height it simply
            overflowed and the extra content was clipped with nothing to
            scroll. min-h-0 lets it shrink so its own body can scroll instead. */}
        <Panel title="Synchronisation" icon={RefreshCw} className="min-h-0">
          <div className="p-4 flex flex-col gap-3 xl:flex-1 xl:min-h-0 xl:overflow-y-auto">
            <dl className="text-sm">
              <div className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-muted-foreground">Local API</dt>
                <dd>
                  <StatusBadge
                    role={online ? 'ok' : 'critical'}
                    label={online ? 'Connected' : 'Disconnected'}
                    size="sm"
                  />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-1.5">
                <dt className="text-muted-foreground">Queued for shore</dt>
                <dd className="readout text-foreground font-medium">{pending}</dd>
              </div>
              <div className="flex items-start justify-between gap-3 py-1.5">
                <dt className="text-muted-foreground shrink-0">Last success</dt>
                <dd className="readout text-xs text-foreground text-right break-words">
                  {syncStatus?.lastSuccess ? new Date(syncStatus.lastSuccess).toLocaleString() : 'Never'}
                </dd>
              </div>
              {/* Which config bundle this vessel is actually running. Without
                  it, "sync succeeded" and "sync succeeded but shore sent no
                  configuration" looked identical from here. */}
              <div className="flex items-start justify-between gap-3 py-1.5">
                <dt className="text-muted-foreground shrink-0">Config bundle</dt>
                <dd className="readout text-xs text-right break-words">
                  {syncStatus?.appliedBundleId ? (
                    <span className="text-foreground">
                      v{syncStatus.appliedBundleVersion}
                      <span className="block text-muted-foreground">
                        {syncStatus.appliedBundleId.slice(0, 8)}…
                      </span>
                    </span>
                  ) : (
                    <span className="text-status-warn">None received</span>
                  )}
                </dd>
              </div>
            </dl>

            {syncStatus?.nameMismatch && (
              <Alert tone="warn" title="Name differs from office">
                This terminal is set up as “{syncStatus.vesselName}”, but office
                records it as “{syncStatus.officeVesselName}”. Reports still sync
                correctly — the names are simply out of step.
              </Alert>
            )}

            {syncStatus?.configNotice && (
              <Alert tone="warn" title="No configuration assigned">
                {syncStatus.configNotice}
              </Alert>
            )}

            {/* Cycle history. Current state alone could never show that a run
                had failed — the next run overwrote it — which is how a long
                run of silent failures stayed invisible. */}
            {syncHistory.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="instrument-label mb-2">Recent syncs</p>
                <ul className="flex flex-col gap-1">
                  {syncHistory.map((run) => {
                    const tone =
                      run.outcome === 'success'
                        ? 'text-status-ok'
                        : run.outcome === 'partial'
                          ? 'text-status-warn'
                          : 'text-status-critical';
                    const problem = run.configError || run.pushError || run.configNotice;
                    return (
                      <li key={run.id} className="flex items-start justify-between gap-3 text-xs">
                        <span className="readout text-muted-foreground shrink-0">
                          {new Date(run.startedAt).toLocaleTimeString()}
                        </span>
                        <span className="min-w-0 flex-1 text-right">
                          <span className={`font-medium ${tone}`}>{run.outcome}</span>
                          {run.trigger === 'manual' && (
                            <span className="text-muted-foreground"> · manual</span>
                          )}
                          {problem && (
                            <span className="block text-muted-foreground break-words">{problem}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {/* mt-auto so the action hugs the bottom of the panel instead of
                floating directly under the readouts with dead space beneath
                it. When the body does overflow — mismatch alert plus a run
                history — there is no free space to absorb, so it simply
                stays last and scrolls with the rest. */}
            <Button
              onClick={() => syncNowMutation.mutate()}
              disabled={syncNowMutation.isPending || !syncStatus?.enrolled}
              className="w-full justify-center xl:mt-auto"
            >
              {syncNowMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              {syncNowMutation.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
        </Panel>

      </div>
    </div>
  );
}
