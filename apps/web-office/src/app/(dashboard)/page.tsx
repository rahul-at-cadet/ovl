'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Ship, Database, AlertCircle, Activity } from 'lucide-react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';

export default function OfficeDashboardPage() {
  const pingQuery = trpc.ping.useQuery({ vesselId: 'office-dashboard' });
  const { data: dashboard, isLoading: isDashboardLoading } = trpc.dashboard.getOverview.useQuery();

  const kpis = [
    { label: 'Active Vessels', value: dashboard?.activeVessels ?? '...', icon: Ship, color: 'text-muted-foreground' },
    { label: 'Incoming Reports (24h)', value: dashboard?.incomingReports ?? '...', icon: Database, color: 'text-muted-foreground' },
    { label: 'Sync Warnings', value: dashboard?.syncWarnings ?? '...', icon: AlertCircle, color: dashboard?.syncWarnings ? 'text-red-400' : 'text-muted-foreground' },
    { label: 'Network Uptime', value: dashboard ? `${dashboard.networkUptime}%` : '...', icon: Activity, color: pingQuery.isSuccess ? 'text-green-400' : 'text-muted-foreground' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Fleet Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm">Real-time telemetry and aggregated reporting from all vessels.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-border bg-card text-foreground hover:text-foreground rounded-sm h-8 text-xs">
            Export Report
          </Button>
          <Link href="/reports">
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-8 text-xs font-medium shadow-sm">
              View All Reports
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {kpis.map((kpi) => (
          <div key={kpi.label}>
            <Card className="bg-card/50 border-border backdrop-blur-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {kpi.label}
                </CardTitle>
                <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-foreground">{kpi.value}</div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2 bg-card/50 border-border">
          <CardHeader>
            <CardTitle className="text-xl">Live Sync Stream</CardTitle>
            <CardDescription>Incoming events from the edge network</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
              {isDashboardLoading ? (
                <p className="text-sm text-muted-foreground text-center py-4">Loading stream...</p>
              ) : dashboard?.liveStream && dashboard.liveStream.length > 0 ? (
                dashboard.liveStream.map((activity: any, i: number) => (
                  <div key={i} className="flex items-center gap-4 p-3 rounded-md bg-background/30 border border-border/50 hover:bg-muted/30 transition-colors">
                    <div className="p-2 rounded-sm border bg-card border-border text-muted-foreground">
                      <Database className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-foreground">{activity.event}</h4>
                      <p className="text-xs text-muted-foreground">Vessel: {activity.vessel}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">{activity.time}</span>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No recent activity.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border rounded-md">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-medium">System Integrity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Database Sync</span>
                <span className="text-foreground">
                  {isDashboardLoading ? 'Syncing...' : `${dashboard?.syncHealthPercent ?? 100}%`}
                </span>
              </div>
              <div className="h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${isDashboardLoading ? 'bg-zinc-300 w-1/2 animate-pulse' : (dashboard?.syncHealthPercent ?? 100) < 100 ? 'bg-amber-500' : 'bg-green-500'}`}
                  style={isDashboardLoading ? undefined : { width: `${dashboard?.syncHealthPercent ?? 100}%` }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">API Status</span>
                <span className="text-foreground">{pingQuery.isLoading ? 'Connecting...' : pingQuery.isError ? 'Offline' : 'Online'}</span>
              </div>
              <div className="h-1 bg-muted rounded-full overflow-hidden">
                <div className={`h-full ${pingQuery.isSuccess ? 'bg-green-500 w-[100%]' : pingQuery.isError ? 'bg-red-500 w-0' : 'bg-zinc-300 w-[20%]'}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
