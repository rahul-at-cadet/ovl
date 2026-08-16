'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FileText, Plus, CloudOff, CheckCircle, Wifi } from 'lucide-react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';

export default function DashboardPage() {
  const pingQuery = trpc.ping.useQuery();

  const kpis = [
    { label: 'Unsynced Drafts', value: '2', icon: FileText, color: 'text-zinc-400' },
    { label: 'Pending Sync', value: '1', icon: CloudOff, color: 'text-zinc-400' },
    { label: 'System Health', value: pingQuery.isSuccess ? 'Good' : 'Error', icon: CheckCircle, color: pingQuery.isSuccess ? 'text-green-400' : 'text-zinc-400' },
    { label: 'Network', value: pingQuery.isSuccess ? 'Online' : 'Offline', icon: Wifi, color: pingQuery.isSuccess ? 'text-green-400' : 'text-zinc-400' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800 pb-6 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Terminal Dashboard</h1>
          <p className="text-zinc-400 mt-1 text-sm">Local edge reporting and synchronization.</p>
        </div>
        <Link href="/reports/new">
          <Button className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-sm h-8 text-xs font-medium shadow-sm">
            <Plus className="w-4 h-4 mr-2" />
            New Report
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {kpis.map((stat) => (
          <Card key={stat.label} className="bg-zinc-900/50 border-zinc-800 rounded-md">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-medium text-zinc-400">
                {stat.label}
              </CardTitle>
              <stat.icon className={`w-3 h-3 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-zinc-100">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-zinc-900/50 border-zinc-800 rounded-md">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
            <CardDescription>Local persistence logs</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { title: 'Bunker Report', status: 'Draft', time: '10 mins ago' },
                { title: 'EDN Report', status: 'Pending Sync', time: '1 hour ago' },
                { title: 'Cargo Nomination', status: 'Synced', time: 'Yesterday' },
              ].map((activity, i) => (
                <div key={i} className="flex items-center gap-4 p-3 rounded-md bg-zinc-950/30 border border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <div className="p-2 rounded-sm border bg-zinc-900 border-zinc-800 text-zinc-400">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-medium text-zinc-200">{activity.title}</h4>
                    <p className="text-xs text-zinc-500">{activity.status}</p>
                  </div>
                  <span className="text-xs text-zinc-600">{activity.time}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900/50 border-zinc-800 rounded-md">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-medium">Sync Queue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-400">Local API Connection</span>
                <span className="text-zinc-100">{pingQuery.isLoading ? 'Connecting...' : pingQuery.isSuccess ? 'Connected' : 'Disconnected'}</span>
              </div>
              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div className={`h-full ${pingQuery.isSuccess ? 'bg-green-500 w-full' : pingQuery.isLoading ? 'bg-zinc-600 w-1/2 animate-pulse' : 'bg-red-500 w-full'}`} />
              </div>
              <p className="text-xs text-zinc-500 mt-2">{pingQuery.isSuccess ? pingQuery.data.message : 'Awaiting connection to Local API.'}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
