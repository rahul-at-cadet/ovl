'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Ship, Database, AlertCircle, Activity } from 'lucide-react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';

export default function OfficeDashboardPage() {
  const pingQuery = trpc.ping.useQuery({ vesselId: 'office-dashboard' });
  const configQuery = trpc.sync.pullConfig.useQuery({});

  const kpis = [
    { label: 'Active Vessels', value: '42', icon: Ship, color: 'text-zinc-400' },
    { label: 'Incoming Reports (24h)', value: '156', icon: Database, color: 'text-zinc-400' },
    { label: 'Sync Warnings', value: configQuery.isError ? '1' : '0', icon: AlertCircle, color: configQuery.isError ? 'text-red-400' : 'text-zinc-400' },
    { label: 'Network Uptime', value: pingQuery.isSuccess ? '99.9%' : '...', icon: Activity, color: pingQuery.isSuccess ? 'text-green-400' : 'text-zinc-400' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800 pb-6 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Fleet Overview</h1>
          <p className="text-zinc-400 mt-1 text-sm">Real-time telemetry and aggregated reporting from all vessels.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white rounded-sm h-8 text-xs">
            Export Report
          </Button>
          <Link href="/reports">
            <Button className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-sm h-8 text-xs font-medium shadow-sm">
              View All Reports
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {kpis.map((kpi) => (
          <div key={kpi.label}>
            <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-slate-400">
                  {kpi.label}
                </CardTitle>
                <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-slate-100">{kpi.value}</div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2 bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="text-xl">Live Sync Stream</CardTitle>
            <CardDescription>Incoming events from the edge network</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { vessel: 'Seawise Giant', event: 'Bunker Report Received', time: 'Just now' },
                { vessel: 'Emma Maersk', event: 'Log Abstract Synced', time: '5 mins ago' },
                { vessel: 'TI Europe', event: 'EDN Report Received', time: '12 mins ago' },
                { vessel: 'Batillus', event: 'Sync Timeout Detected', time: '1 hr ago' },
              ].map((activity, i) => (
                <div key={i} className="flex items-center gap-4 p-3 rounded-md bg-zinc-950/30 border border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <div className="p-2 rounded-sm border bg-zinc-900 border-zinc-800 text-zinc-400">
                    <Database className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-medium text-zinc-200">{activity.event}</h4>
                    <p className="text-xs text-zinc-500">Vessel: {activity.vessel}</p>
                  </div>
                  <span className="text-xs text-zinc-600">{activity.time}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900/50 border-zinc-800 rounded-md">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-medium">System Integrity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-400">Database Sync</span>
                <span className="text-zinc-100">{configQuery.isLoading ? 'Syncing...' : '100%'}</span>
              </div>
              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div className={`h-full bg-zinc-300 ${configQuery.isLoading ? 'w-1/2 animate-pulse' : 'w-full'}`} />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-400">API Status</span>
                <span className="text-zinc-100">{pingQuery.isLoading ? 'Connecting...' : pingQuery.isError ? 'Offline' : 'Online'}</span>
              </div>
              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div className={`h-full ${pingQuery.isSuccess ? 'bg-green-500 w-[100%]' : pingQuery.isError ? 'bg-red-500 w-0' : 'bg-zinc-300 w-[20%]'}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
