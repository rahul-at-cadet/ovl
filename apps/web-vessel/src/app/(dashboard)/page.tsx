'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

  const inProgress = reports.filter(r => r.state === 'draft').slice(0, 4);
  const allInProgress = reports.filter(r => r.state === 'draft');
  const recent = reports.filter(r => r.state !== 'draft').slice(0, 5);

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
    { label: 'Unsynced Drafts', value: inProgress.length.toString(), icon: FileText, color: 'text-amber-400' },
    { label: 'Pending Sync', value: '1', icon: CloudOff, color: 'text-muted-foreground' },
    { label: 'System Health', value: pingQuery.isSuccess ? 'Good' : 'Error', icon: CheckCircle, color: pingQuery.isSuccess ? 'text-green-400' : 'text-muted-foreground' },
    { label: 'Network', value: pingQuery.isSuccess ? 'Online' : 'Offline', icon: Wifi, color: pingQuery.isSuccess ? 'text-green-400' : 'text-muted-foreground' },
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Terminal Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">Local edge reporting and synchronization.</p>
        </div>
        <Link href="/reports/new">
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-8 text-xs font-medium shadow-sm">
            <Plus className="w-4 h-4 mr-2" />
            New Report
          </Button>
        </Link>
      </div>

      {setupStatus && !setupStatus.isConfigured && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-md p-4 flex items-start gap-3 text-amber-400">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold">Not Enrolled</h3>
            <p className="text-xs text-amber-400/80 mt-1">This vessel isn't connected to an office yet. Enroll any time from Settings.</p>
          </div>
        </div>
      )}

      {isOverdue && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-md p-4 flex items-start gap-3 text-red-400">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold">Report Overdue</h3>
            <p className="text-xs text-red-400/80 mt-1">Overdue by {overdueByStr}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
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

      {/* Main Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6">
        
        {/* Main Content Area */}
        <div className="space-y-6">
          
          {/* Suggested Next Report moved into main column */}
          {suggestions && suggestions.length > 0 && (
            <Card className="bg-gradient-to-r from-blue-500/10 to-muted/50 border-blue-500/30 rounded-xl">
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Suggested Next Report</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-row justify-between items-center px-5 pb-4">
                <div>
                  <div className="text-xl font-bold text-foreground">{suggestions[0]}</div>
                  {isOverdue && <p className="text-[11px] text-red-400 font-semibold mt-0.5">Report overdue by {overdueByStr}</p>}
                </div>
                <Button size="sm" onClick={() => router.push('/reports/new')} className="bg-blue-600 hover:bg-blue-500 text-white rounded-lg h-8 px-4 text-xs font-medium">
                  Open
                </Button>
              </CardContent>
            </Card>
          )}

          <div className="flex items-center justify-between border-b border-border/50 pb-3">
            <h2 className="text-lg font-semibold text-foreground tracking-tight">In Progress</h2>
            <Button 
              size="sm"
              variant="outline"
              className="bg-card/50 border-border text-foreground hover:text-foreground hover:bg-muted h-7 px-3 text-xs"
              onClick={() => router.push('/reports')}
            >
              View all
            </Button>
          </div>

          {reportsLoading ? (
            <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-2xl">
              <CardContent className="p-12 flex flex-col items-center justify-center space-y-4">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                <p className="text-sm font-medium text-muted-foreground">Loading your drafts...</p>
              </CardContent>
            </Card>
          ) : inProgress.length === 0 ? (
            <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-2xl border-dashed">
              <CardContent className="p-16 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 rounded-full bg-card flex items-center justify-center border border-border mb-6 shadow-inner">
                  <FileText className="w-8 h-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-2">No active drafts</h3>
                <p className="text-sm text-muted-foreground max-w-sm">Start a new report to see it here. Your progress will be automatically saved.</p>
                <Button className="mt-8 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl shadow-[0_0_20px_rgba(79,70,229,0.3)]">
                  Start New Report
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl overflow-hidden shadow-xl">
                <div className="divide-y divide-border">
                  {inProgress.map(report => (
                    <div 
                      key={report.reportId} 
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-card/80 transition-all cursor-pointer group"
                      onClick={() => router.push(`/reports/${report.reportId}`)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2 rounded-md border bg-card border-border text-muted-foreground shadow-inner group-hover:text-foreground transition-colors shrink-0">
                          <FileText className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="text-[13px] font-semibold tracking-wide text-foreground truncate group-hover:text-foreground transition-colors">{report.schemaName || 'Unnamed Report'}</h4>
                          <p className="text-[11px] font-medium text-muted-foreground truncate mt-0.5">Started {new Date(report.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                        <span className="text-[9px] px-2 py-0.5 rounded uppercase font-bold tracking-widest bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          Draft
                        </span>
                        <span className="text-[11px] font-semibold text-indigo-400 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                          Resume <ArrowRight className="w-3 h-3 ml-1" />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
              {allInProgress.length > 4 && (
                <Button 
                  variant="ghost" 
                  className="w-full text-muted-foreground hover:text-indigo-400 bg-card/30 hover:bg-card/80 border border-border/50 rounded-xl h-11" 
                  onClick={() => router.push('/reports')}
                >
                  View all {allInProgress.length} active drafts <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between border-b border-border/50 pb-3 mt-8">
            <h2 className="text-lg font-semibold text-foreground tracking-tight">Recent Reports</h2>
            <Button 
              size="sm"
              variant="outline"
              className="bg-card/50 border-border text-foreground hover:text-foreground hover:bg-muted h-7 px-3 text-xs"
              onClick={() => router.push('/reports')}
            >
              View all
            </Button>
          </div>

          {reportsLoading ? (
            <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl">
              <CardContent className="p-8 flex flex-col items-center justify-center space-y-3">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
                <p className="text-xs font-medium text-muted-foreground">Loading recent reports...</p>
              </CardContent>
            </Card>
          ) : recent.length === 0 ? (
            <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl border-dashed">
              <CardContent className="p-8 flex flex-col items-center justify-center text-center">
                 <p className="text-xs font-medium text-muted-foreground">No reports have been submitted yet.</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl overflow-hidden">
              <div className="divide-y divide-border">
                {recent.map((report) => (
                  <div 
                    key={report.reportId} 
                    className="flex items-center gap-3 p-4 hover:bg-card/80 transition-all cursor-pointer group"
                    onClick={() => router.push(`/reports/${report.reportId}`)}
                  >
                    <div className="p-2 rounded-md border bg-card border-border text-muted-foreground shadow-inner group-hover:text-foreground transition-colors shrink-0">
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-[13px] font-semibold tracking-wide text-foreground truncate group-hover:text-foreground transition-colors">{report.schemaName}</h4>
                      <p className="text-[11px] font-medium text-muted-foreground truncate mt-0.5">{report.createdBy}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-widest border ${
                        report.state === 'submitted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[inset_0_1px_0_rgba(16,185,129,0.1)]' :
                        report.state === 'draft' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-zinc-500/10 text-muted-foreground border-zinc-500/20'
                      }`}>
                        {report.state}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono font-medium">{new Date(report.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Sidebar Widgets */}
        <div className="space-y-6">
          <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl shadow-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/10 rounded-full blur-[30px] pointer-events-none" />
            <CardHeader className="pb-3 pt-4 border-b border-border/30 bg-background/20">
              <CardTitle className="text-[13px] font-semibold tracking-wide text-foreground flex items-center gap-2">
                <Ship className="w-3.5 h-3.5 text-indigo-400" />
                Active Voyage
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 pb-4">
              {voyage ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mb-1">Voyage Number</p>
                    <p className="text-lg font-semibold tracking-tight text-foreground">{voyage.voyageNumber}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 relative">
                    <div className="absolute top-4 left-3 right-3 h-[1px] bg-muted border-t border-dashed border-border/50" />
                    <div className="relative z-10 bg-background/80 p-1.5 rounded-md border border-border/60 shadow-sm">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mb-0.5 text-center">Departure</p>
                      <p className="text-[11px] font-medium text-foreground text-center truncate">{voyage.departurePort}</p>
                    </div>
                    <div className="relative z-10 bg-background/80 p-1.5 rounded-md border border-border/60 shadow-sm">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold mb-0.5 text-center">Arrival</p>
                      <p className="text-[11px] font-medium text-foreground text-center truncate">{voyage.arrivalPort}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-4 text-center">
                  <div className="w-8 h-8 rounded-full bg-card border border-border flex items-center justify-center mb-2">
                    <Ship className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">No active voyage detected.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-background/40 border-border/60 backdrop-blur-sm rounded-xl shadow-lg relative overflow-hidden">
            <div className="absolute bottom-0 right-0 w-24 h-24 bg-emerald-500/10 rounded-full blur-[30px] pointer-events-none" />
            <CardHeader className="pb-3 pt-4 border-b border-border/30 bg-background/20">
              <CardTitle className="text-[13px] font-semibold tracking-wide text-foreground flex items-center justify-between">
                Sync Status
                {syncStatus?.enrolled && pingQuery.isSuccess && (
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4 pb-4">
              <div className="space-y-2.5 text-xs font-medium">
                <div className="flex justify-between items-center bg-card/50 p-1.5 px-2 rounded-md border border-border/50">
                  <span className="text-muted-foreground">Local API</span>
                  <span className={pingQuery.isSuccess ? 'text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded border border-emerald-500/20 text-[10px]' : 'text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded border border-red-500/20 text-[10px]'}>
                    {pingQuery.isSuccess ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
                <div className="flex justify-between items-center bg-card/50 p-1.5 px-2 rounded-md border border-border/50">
                  <span className="text-muted-foreground">Enrolled</span>
                  <span className={syncStatus?.enrolled ? 'text-indigo-400 text-[11px]' : 'text-muted-foreground text-[11px]'}>{syncStatus?.enrolled ? 'Yes' : 'No'}</span>
                </div>
                <div className="flex flex-col gap-1 pt-2">
                  <span className="text-[9px] text-muted-foreground uppercase tracking-widest font-bold">Last Success</span>
                  <span className="text-foreground font-mono text-[10px] bg-card px-2 py-1 rounded border border-border">
                    {syncStatus?.lastSuccess ? new Date(syncStatus.lastSuccess).toLocaleString() : 'Never'}
                  </span>
                </div>
                {syncStatus?.lastError && (
                  <div className="text-[10px] text-red-400 mt-1.5 bg-red-500/10 p-1.5 rounded border border-red-500/20 break-words">
                    {syncStatus.lastError}
                  </div>
                )}
                
                <Button 
                  size="sm"
                  onClick={() => syncNowMutation.mutate()} 
                  disabled={syncNowMutation.isPending || !syncStatus?.enrolled}
                  className="w-full mt-4 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-lg h-8 text-xs shadow-[0_0_10px_rgba(255,255,255,0.1)] transition-all disabled:bg-muted disabled:text-muted-foreground"
                >
                  <CloudOff className="w-3.5 h-3.5 mr-1.5" />
                  {syncNowMutation.isPending ? 'Syncing...' : 'Sync Now'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
