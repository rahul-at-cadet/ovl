'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Satellite, Database, Activity, RefreshCw, Save, Cpu } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useToastManager } from '@/components/ui/toast';

export default function SettingsPage() {
  const toastManager = useToastManager();
  const { data: settings, isLoading } = trpc.settings.get.useQuery();
  const updateSettingsMutation = trpc.settings.update.useMutation();

  const [syncInterval, setSyncInterval] = useState('15');
  const [maxBandwidth, setMaxBandwidth] = useState('256');
  const [pauseSyncing, setPauseSyncing] = useState(false);

  useEffect(() => {
    if (settings) {
      if (settings.sync_interval) setSyncInterval(settings.sync_interval);
      if (settings.max_bandwidth) setMaxBandwidth(settings.max_bandwidth);
      if (settings.pause_syncing) setPauseSyncing(settings.pause_syncing === 'true');
    }
  }, [settings]);

  const handleApplyNetworkSettings = () => {
    updateSettingsMutation.mutate({
      sync_interval: syncInterval,
      max_bandwidth: maxBandwidth,
      pause_syncing: pauseSyncing ? 'true' : 'false',
    }, {
      onSuccess: () => toastManager.add({ title: 'Network settings applied', type: 'success' }),
      onError: (err) => toastManager.add({ title: 'Failed to apply settings', description: err.message, type: 'error' })
    });
  };

  const handleForceSync = () => {
    toastManager.add({ title: 'Sync triggered', description: 'Running in background.', type: 'info' });
  };

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading settings...</div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-6xl">
      <div className="border-b border-border/60 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Local Node Settings</h1>
        <p className="text-muted-foreground mt-1.5 text-sm font-medium">Configure edge infrastructure, satellite networking, and diagnostic logging.</p>
      </div>

      <Tabs defaultValue="network" orientation="vertical" className="w-full">
        <div className="flex flex-col md:flex-row gap-8 w-full">
          <TabsList className="flex flex-col h-auto bg-transparent gap-2 w-full md:w-64 shrink-0">
            <TabsTrigger 
              value="network" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted/50 data-[state=active]:text-foreground text-muted-foreground hover:bg-card/50 transition-all rounded-md"
            >
              <Satellite className="w-4 h-4 mr-3" />
              Network & Sync
            </TabsTrigger>
            <TabsTrigger 
              value="storage" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted/50 data-[state=active]:text-foreground text-muted-foreground hover:bg-card/50 transition-all rounded-md"
            >
              <Database className="w-4 h-4 mr-3" />
              Local Storage
            </TabsTrigger>
            <TabsTrigger 
              value="sensors" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted/50 data-[state=active]:text-foreground text-muted-foreground hover:bg-card/50 transition-all rounded-md"
            >
              <Cpu className="w-4 h-4 mr-3" />
              Hardware Sensors
            </TabsTrigger>
            <TabsTrigger 
              value="diagnostics" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted/50 data-[state=active]:text-foreground text-muted-foreground hover:bg-card/50 transition-all rounded-md"
            >
              <Activity className="w-4 h-4 mr-3" />
              Diagnostics
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 space-y-6">
            <TabsContent value="network" className="mt-0 space-y-6">
              <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-border/60 pb-4 bg-card/20 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Satellite Uplink</CardTitle>
                    <CardDescription className="text-xs text-muted-foreground mt-1">Configure sync intervals and bandwidth limits.</CardDescription>
                  </div>
                  <Button variant="outline" onClick={handleForceSync} className="h-8 border-border bg-background text-foreground">
                    <RefreshCw className="w-3 h-3 mr-2" />
                    Force Sync Now
                  </Button>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">Sync Interval (Minutes)</Label>
                      <Input type="number" value={syncInterval} onChange={e => setSyncInterval(e.target.value)} className="bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">Max Bandwidth (Kbps)</Label>
                      <Input type="number" value={maxBandwidth} onChange={e => setMaxBandwidth(e.target.value)} className="bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-4 rounded-lg bg-background/50 border border-border/60 mt-4">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">Pause Syncing (Port Mode)</p>
                      <p className="text-xs text-muted-foreground">Temporarily halt all shore-side telemetry and reports syncing.</p>
                    </div>
                    <div onClick={() => setPauseSyncing(!pauseSyncing)} className="h-5 w-9 rounded-full bg-muted flex items-center p-0.5 cursor-pointer border border-border relative">
                       <div className={`h-4 w-4 rounded-full bg-zinc-400 absolute shadow-sm transition-all ${pauseSyncing ? 'left-4 bg-blue-500' : 'left-0.5'}`} />
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="bg-background/40 border-t border-border/60 p-4 flex justify-end">
                  <Button onClick={handleApplyNetworkSettings} disabled={updateSettingsMutation.isPending} className="bg-blue-600 hover:bg-blue-500 text-white rounded-md h-9 text-sm font-semibold shadow-sm transition-all">
                    {updateSettingsMutation.isPending ? 'Applying...' : 'Apply Network Settings'}
                  </Button>
                </CardFooter>
              </Card>
            </TabsContent>

            <TabsContent value="storage" className="mt-0">
              <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Data Retention</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Manage local SQLite database pruning.</CardDescription>
                </CardHeader>
                <CardContent className="pt-12 pb-12 flex flex-col items-center justify-center text-center space-y-4">
                  <Database className="w-8 h-8 text-muted-foreground mb-2" />
                  <p className="text-sm font-medium text-muted-foreground">Database using 14.2 MB of space.</p>
                  
                  <div className="flex gap-4 mt-6">
                    <Button variant="outline" className="border-border bg-background hover:bg-card text-foreground" onClick={() => window.open('http://localhost:3003/system/backup/download')}>
                      <Save className="w-4 h-4 mr-2" />
                      Download Full Backup
                    </Button>
                    <Button variant="outline" className="border-border bg-background hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 text-foreground">
                      Clear Synced Records
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="sensors" className="mt-0">
              <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Hardware Sensors</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Configure NMEA 0183/2000 connections for auto-populating coordinates.</CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">NMEA Endpoint URL / Serial Port</Label>
                    <Input type="text" placeholder="tcp://192.168.1.100:10110" className="bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10" />
                  </div>
                  <Button className="bg-blue-600 hover:bg-blue-500 text-white rounded-md h-9 text-sm font-semibold shadow-sm transition-all mt-2">
                    Save Sensor Config
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="diagnostics" className="mt-0">
              <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">System Logs</CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  <div className="bg-background border border-border/60 rounded-md p-4 font-mono text-[10px] text-muted-foreground h-64 overflow-y-auto">
                    <div>[2026-08-16T12:00:01Z] INFO: Initializing edge node...</div>
                    <div>[2026-08-16T12:00:02Z] INFO: SQLite database connected.</div>
                    <div>[2026-08-16T12:05:00Z] INFO: Attempting shore sync...</div>
                    <div className="text-emerald-400">[2026-08-16T12:05:03Z] SUCCESS: Synced 0 reports and updated 2 schemas.</div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </div>
      </Tabs>
    </div>
  );
}
