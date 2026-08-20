'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FileText, Plus, CloudOff, CheckCircle, Wifi, AlertTriangle, ArrowRight, Loader2, Ship } from 'lucide-react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
  const pingQuery = trpc.ping.useQuery();
  const router = useRouter();

  const { data: reports = [], isLoading: reportsLoading } = trpc.reports.listReports.useQuery({ schemaName: '' });
  const { data: voyage } = trpc.system.getActiveVoyage.useQuery();
  const { data: setupStatus } = trpc.setup.status.useQuery();
  const { data: syncStatus } = trpc.sync.status.useQuery();
  const { data: settings } = trpc.settings.get.useQuery();
  const { data: suggestions } = trpc.reports.listEventSuggestions.useQuery({ schemaName: 'log-abstract' });
  const syncNowMutation = trpc.sync.now.useMutation();

  // Full count feeds the KPI card; the list itself shows only the most
  // recent few with "View all" for the rest — otherwise a vessel with
  // many open drafts turns this into an unbounded list, invisible on
  // desktop behind the panel's own internal scroll but, once that
  // panel-level scroll goes away below lg (mobile stacks to one
  // column), it just makes the whole page arbitrarily long instead.
  const allInProgress = reports.filter(r => r.state === 'draft');
  const inProgress = allInProgress.slice(0, 5);
  const recent = reports.filter(r => r.state !== 'draft').slice(0, 6);

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

  const kpis = [
    { label: 'Unsynced Drafts', value: allInProgress.length.toString(), icon: FileText, color: 'text-amber-400' },
    { label: 'Pending Sync', value: (syncStatus?.pendingCount ?? 0).toString(), icon: CloudOff, color: (syncStatus?.pendingCount ?? 0) > 0 ? 'text-amber-400' : 'text-muted-foreground' },
    { label: 'System Health', value: pingQuery.isSuccess ? 'Good' : 'Error', icon: CheckCircle, color: pingQuery.isSuccess ? 'text-emerald-400' : 'text-muted-foreground' },
    { label: 'Network', value: pingQuery.isSuccess ? 'Online' : 'Offline', icon: Wifi, color: pingQuery.isSuccess ? 'text-emerald-400' : 'text-muted-foreground' },
  ];

  return (
    // Fixed to the viewport on desktop, not the page — a bridge display
    // shouldn't need scrolling to see fleet status at a glance. Below
    // lg, the 3-column instrument panel stacks to 1 column, so the same
    // fixed total height would squeeze 3x the content into the space
    // meant for one column and clip it — mobile gets the page's natural
    // scroll instead, matching how every other page on a phone works.
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500 lg:h-[calc(100vh-140px)] lg:overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Terminal Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">Local edge reporting and synchronization.</p>
        </div>
        <Link href="/reports/new">
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-10 text-sm font-medium shadow-sm px-5">
            <Plus className="w-4 h-4 mr-2" />
            New Report
          </Button>
        </Link>
      </div>

      {(setupStatus && !setupStatus.isConfigured) || isOverdue ? (
        <div className="flex flex-col sm:flex-row gap-3 shrink-0">
          {setupStatus && !setupStatus.isConfigured && (
            <div className="flex-1 bg-amber-500/10 border border-amber-500/20 rounded-md p-3 flex items-start gap-3 text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold">Not Enrolled</h3>
                <p className="text-xs text-amber-400/80 mt-0.5">Enroll any time from Settings.</p>
              </div>
            </div>
          )}
          {isOverdue && (
            <div className="flex-1 bg-red-500/10 border border-red-500/20 rounded-md p-3 flex items-start gap-3 text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold">Report Overdue</h3>
                <p className="text-xs text-red-400/80 mt-0.5">Overdue by {overdueByStr}</p>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* KPI strip — always visible, single row, never scrolls. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
        {kpis.map((stat) => (
          <Card key={stat.label} className="bg-card/50 border-border rounded-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <stat.icon className={`w-4 h-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Instrument panel: three fixed-height columns filling the rest
          of the viewport. Each has its own internal scroll — a long
          drafts list never pushes Voyage/Sync status off-screen, and
          the page itself never grows taller than the window. */}
      <div className="grid grid-cols-1 gap-4 lg:flex-1 lg:min-h-0 lg:grid-cols-[1.3fr_1fr_1fr]">
        {/* Column 1: In Progress */}
        <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl flex flex-col lg:min-h-0 lg:overflow-hidden">
          <CardHeader className="pb-3 pt-4 border-b border-border/50 shrink-0 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm font-semibold tracking-wide text-foreground">In Progress</CardTitle>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => router.push('/reports')}>
              View all <ArrowRight className="w-3 h-3 ml-1" />
            </Button>
          </CardHeader>
          <CardContent className="p-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
            {reportsLoading ? (
              <div className="p-8 flex flex-col items-center justify-center space-y-3">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <p className="text-xs font-medium text-muted-foreground">Loading drafts...</p>
              </div>
            ) : inProgress.length === 0 ? (
              <div className="p-8 flex flex-col items-center justify-center text-center h-full">
                <div className="w-12 h-12 rounded-full bg-card flex items-center justify-center border border-border mb-4 shadow-inner">
                  <FileText className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium text-foreground mb-1">No active drafts</h3>
                <p className="text-xs text-muted-foreground max-w-[220px]">Start a new report and your progress saves automatically.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {inProgress.map(report => (
                  <div
                    key={report.reportId}
                    className="flex items-center justify-between gap-3 p-3 hover:bg-card/80 transition-all cursor-pointer group"
                    onClick={() => router.push(`/reports/${report.reportId}`)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-md border bg-card border-border text-muted-foreground shrink-0">
                        <FileText className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-semibold text-foreground truncate">{report.schemaName || 'Unnamed Report'}</h4>
                        <p className="text-xs font-medium text-muted-foreground truncate mt-0.5">Started {new Date(report.createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded uppercase font-bold tracking-widest bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
                      Draft
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Column 2: Suggested Next Report + Active Voyage */}
        <div className="flex flex-col gap-4 lg:min-h-0">
          {suggestions && suggestions.length > 0 && (
            <Card className="bg-gradient-to-r from-primary/10 to-muted/50 border-primary/30 rounded-xl shrink-0">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-xs font-semibold text-primary uppercase tracking-widest">Suggested Next Report</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-row justify-between items-center px-4 pb-3">
                <div>
                  <div className="text-lg font-bold text-foreground">{suggestions[0]}</div>
                  {isOverdue && <p className="text-xs text-red-400 font-semibold mt-0.5">Overdue by {overdueByStr}</p>}
                </div>
                <Button size="sm" onClick={() => router.push('/reports/new')} className="bg-primary hover:bg-primary/90 text-white rounded-lg h-9 px-4 text-xs font-medium">
                  Open
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl relative flex flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-primary/10 rounded-full blur-[30px] pointer-events-none" />
            <CardHeader className="pb-3 pt-4 border-b border-border/30 bg-background/20 shrink-0">
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground flex items-center gap-2">
                <Ship className="w-3.5 h-3.5 text-primary" />
                Active Voyage
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 pb-4 overflow-y-auto">
              {voyage && voyage.voyageNumber ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-widest font-bold mb-1">Voyage Number</p>
                    <p className="text-lg font-semibold tracking-tight text-foreground">{voyage.voyageNumber}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 relative">
                    <div className="absolute top-4 left-3 right-3 h-[1px] bg-muted border-t border-dashed border-border/50" />
                    <div className="relative z-10 bg-background/80 p-1.5 rounded-md border border-border/60 shadow-sm">
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-bold mb-0.5 text-center">From</p>
                      <p className="text-xs font-medium text-foreground text-center truncate">{voyage.fromPort || '—'}</p>
                      {voyage.departedAt && (
                        <p className="text-[10px] text-muted-foreground text-center font-mono mt-0.5">Dep {new Date(voyage.departedAt).toLocaleDateString()}</p>
                      )}
                    </div>
                    <div className="relative z-10 bg-background/80 p-1.5 rounded-md border border-border/60 shadow-sm">
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-bold mb-0.5 text-center">To</p>
                      <p className="text-xs font-medium text-foreground text-center truncate">{voyage.toPort || '—'}</p>
                      {voyage.eta && (
                        <p className="text-[10px] text-muted-foreground text-center font-mono mt-0.5">ETA {new Date(voyage.eta).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                  {/* Always rendered, defaulting to 0% (docked at departure)
                      rather than hidden — an honest "not yet reported"
                      state is still more useful on a bridge display than
                      no progress indicator at all. */}
                  <div>
                    <div className="relative h-1.5 rounded-full bg-muted overflow-visible">
                      <div className="absolute inset-y-0 left-0 bg-primary rounded-full" style={{ width: `${voyage.progressPercent ?? 0}%` }} />
                      <div
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-primary border-2 border-background flex items-center justify-center shadow-sm"
                        style={{ left: `${voyage.progressPercent ?? 0}%` }}
                      >
                        <Ship className="w-2.5 h-2.5 text-primary-foreground" />
                      </div>
                    </div>
                    <div className="flex justify-between mt-2">
                      <span className="text-[10px] text-muted-foreground">
                        {voyage.distanceSailedNm != null ? `${voyage.distanceSailedNm.toFixed(0)} NM sailed` : '—'}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {voyage.distanceRemainingNm != null ? `${voyage.distanceRemainingNm.toFixed(0)} NM remaining` : '—'}
                      </span>
                    </div>
                  </div>
                  {voyage.position && (
                    <div className="pt-2 border-t border-border/40">
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-bold mb-0.5">Position</p>
                      <p className="text-xs font-mono text-foreground">{voyage.position.text}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-4 text-center">
                  <div className="w-8 h-8 rounded-full bg-card border border-border flex items-center justify-center mb-2">
                    <Ship className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">Voyage details will appear here once a report carries a voyage number.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Column 3: Sync Status + Recent Reports */}
        <div className="flex flex-col gap-4 lg:min-h-0">
          <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl shrink-0 relative overflow-hidden">
            <div className="absolute bottom-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full blur-[30px] pointer-events-none" />
            <CardHeader className="pb-3 pt-4 border-b border-border/30 bg-background/20">
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground flex items-center justify-between">
                Sync Status
                {syncStatus?.enrolled && pingQuery.isSuccess && (
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 pt-4 pb-4">
              <div className="flex justify-between items-center bg-card/50 p-1.5 px-2 rounded-md border border-border/50 text-xs font-medium">
                <span className="text-muted-foreground">Local API</span>
                <span className={pingQuery.isSuccess ? 'text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded border border-emerald-500/20' : 'text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded border border-red-500/20'}>
                  {pingQuery.isSuccess ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div className="flex justify-between items-center bg-card/50 p-1.5 px-2 rounded-md border border-border/50 text-xs font-medium">
                <span className="text-muted-foreground">Enrolled</span>
                <span className={syncStatus?.enrolled ? 'text-primary' : 'text-muted-foreground'}>{syncStatus?.enrolled ? 'Yes' : 'No'}</span>
              </div>
              {syncStatus?.lastError && (
                <div className="text-xs text-red-400 bg-red-500/10 p-1.5 rounded border border-red-500/20 break-words">
                  {syncStatus.lastError}
                </div>
              )}
              <Button
                size="sm"
                onClick={() => syncNowMutation.mutate()}
                disabled={syncNowMutation.isPending || !syncStatus?.enrolled}
                className="w-full mt-1 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-lg h-9 text-xs transition-all disabled:bg-muted disabled:text-muted-foreground"
              >
                <CloudOff className="w-3.5 h-3.5 mr-1.5" />
                {syncNowMutation.isPending ? 'Syncing...' : 'Sync Now'}
              </Button>
            </CardContent>
          </Card>

          <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl flex flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden">
            <CardHeader className="pb-3 pt-4 border-b border-border/50 shrink-0 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground">Recent Reports</CardTitle>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => router.push('/reports')}>
                View all <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </CardHeader>
            <CardContent className="p-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
              {reportsLoading ? (
                <div className="p-6 flex flex-col items-center justify-center space-y-2">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                </div>
              ) : recent.length === 0 ? (
                <div className="p-6 flex items-center justify-center text-center h-full">
                  <p className="text-xs font-medium text-muted-foreground">No reports submitted yet.</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {recent.map((report) => (
                    <div
                      key={report.reportId}
                      className="flex items-center gap-2.5 p-2.5 hover:bg-card/80 transition-all cursor-pointer group"
                      onClick={() => router.push(`/reports/${report.reportId}`)}
                    >
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-semibold text-foreground truncate">{report.schemaName}</h4>
                        <p className="text-xs text-muted-foreground truncate">{report.createdBy}</p>
                      </div>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border shrink-0 ${
                        report.state === 'submitted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        report.state === 'remarked' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' :
                        report.state === 'invalidated' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        'bg-zinc-500/10 text-muted-foreground border-zinc-500/20'
                      }`}>
                        {report.state}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
