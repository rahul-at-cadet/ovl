'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import { Satellite, Database, Activity, RefreshCw, Save, Cpu, Loader2, Navigation, LifeBuoy } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { API_ORIGIN } from '@/lib/api-origin';
import { useToastManager } from '@ovl/ui/components/toast';
import { Switch } from '@ovl/ui/components/switch';
import { useScrollActiveTabIntoView } from '@/components/ScrollableTabs';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { RecoveryTab } from './RecoveryTab';

export default function SettingsPage() {
  const toastManager = useToastManager();
  const tabsRef = useScrollActiveTabIntoView<HTMLDivElement>();
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.settings.get.useQuery();
  // Disaster recovery is Master-only server-side (it rewrites the report
  // store), so the tab is hidden rather than shown-and-refused — the same
  // isMaster gate the user roster and AppShell already use.
  const { data: me } = trpc.users.me.useQuery();
  const isMaster = (me?.role ?? '').toLowerCase() === 'master';
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

  // sync.now runs a full push/pull cycle and returns the resulting status.
  // This button used to toast "Sync triggered" without calling anything —
  // on a terminal whose entire job is getting reports to shore, a sync
  // button that only claims to have synced is worse than no button.
  const syncStatusQuery = trpc.sync.status.useQuery();
  const syncNowMutation = trpc.sync.now.useMutation({
    meta: { errorTitle: "Sync didn't complete" },
    onSuccess: (status) => {
      utils.sync.status.invalidate();
      toastManager.add({
        title: status.lastError ? 'Sync finished with errors' : 'Sync complete',
        description: status.lastError
          ? status.lastError
          : `${status.pendingCount} item${status.pendingCount === 1 ? '' : 's'} still queued.`,
        type: status.lastError ? 'warning' : 'success',
      });
    },
  });
  const handleForceSync = () => syncNowMutation.mutate();

  const { data: sensorSource } = trpc.sensors.get.useQuery();
  const [sensorBaseUrl, setSensorBaseUrl] = useState('');
  const [sensorApiKey, setSensorApiKey] = useState('');
  const [sensorEnabled, setSensorEnabled] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (sensorSource) {
      setSensorBaseUrl(sensorSource.baseUrl);
      setSensorEnabled(sensorSource.enabled);
      // apiKey comes back masked (e.g. "••••1234") — never prefill the
      // input with a masked value the officer could accidentally save
      // back as the real key.
    }
  }, [sensorSource]);

  const saveSensorMutation = trpc.sensors.save.useMutation({
    onSuccess: () => {
      toastManager.add({ title: 'Sensor source saved', type: 'success' });
      utils.sensors.get.invalidate();
    },
    onError: (err) => toastManager.add({ title: 'Failed to save sensor source', description: err.message, type: 'error' }),
  });
  const testSensorMutation = trpc.sensors.test.useMutation({
    onSuccess: (result) => setTestResult(result),
    onError: (err) => setTestResult({ ok: false, message: err.message }),
  });

  const { data: vmsSource } = trpc.vms.get.useQuery();
  const [vmsBaseUrl, setVmsBaseUrl] = useState('');
  const [vmsApiKey, setVmsApiKey] = useState('');
  const [vmsEnabled, setVmsEnabled] = useState(false);
  const [vmsTestResult, setVmsTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (vmsSource) {
      setVmsBaseUrl(vmsSource.baseUrl);
      setVmsEnabled(vmsSource.enabled);
      // apiKey comes back masked (e.g. "••••1234") — never prefill the
      // input with a masked value the officer could accidentally save
      // back as the real key.
    }
  }, [vmsSource]);

  const saveVmsMutation = trpc.vms.save.useMutation({
    onSuccess: () => {
      toastManager.add({ title: 'VMS source saved', type: 'success' });
      utils.vms.get.invalidate();
      setVmsApiKey('');
    },
    onError: (err) => toastManager.add({ title: 'Failed to save VMS source', description: err.message, type: 'error' }),
  });
  const testVmsMutation = trpc.vms.test.useMutation({
    onSuccess: (result) => setVmsTestResult(result),
    onError: (err) => setVmsTestResult({ ok: false, message: err.message }),
  });

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading settings...</div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-6xl">
      <div className="border-b border-border pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Local Node Settings</h1>
        <p className="text-muted-foreground mt-1.5 text-sm font-medium">Configure edge infrastructure, satellite networking, and diagnostic logging.</p>
      </div>

      <Tabs defaultValue="network" orientation="vertical" className="w-full">
        <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 w-full min-w-0">
          <TabsList ref={tabsRef} className="max-lg:!flex-row max-lg:!w-full max-lg:!justify-start h-auto bg-transparent gap-1 w-full lg:w-52 shrink-0 max-lg:overflow-x-auto max-lg:overflow-y-hidden lg:overflow-visible p-0 rounded-none border-b border-border lg:border-b-0 lg:border-r lg:pr-2">
            <TabsTrigger 
              value="network" 
              className="max-lg:!w-auto justify-start px-3 min-h-12 text-sm font-medium whitespace-nowrap shrink-0 rounded-sm text-muted-foreground hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none"
            >
              <Satellite className="w-4 h-4 mr-2 shrink-0" />
              Network & Sync
            </TabsTrigger>
            <TabsTrigger 
              value="storage" 
              className="max-lg:!w-auto justify-start px-3 min-h-12 text-sm font-medium whitespace-nowrap shrink-0 rounded-sm text-muted-foreground hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none"
            >
              <Database className="w-4 h-4 mr-2 shrink-0" />
              Local Storage
            </TabsTrigger>
            <TabsTrigger 
              value="sensors" 
              className="max-lg:!w-auto justify-start px-3 min-h-12 text-sm font-medium whitespace-nowrap shrink-0 rounded-sm text-muted-foreground hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none"
            >
              <Cpu className="w-4 h-4 mr-2 shrink-0" />
              Hardware Sensors
            </TabsTrigger>
            <TabsTrigger
              value="vms"
              className="max-lg:!w-auto justify-start px-3 min-h-12 text-sm font-medium whitespace-nowrap shrink-0 rounded-sm text-muted-foreground hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none"
            >
              <Navigation className="w-4 h-4 mr-2 shrink-0" />
              VMS
            </TabsTrigger>
            <TabsTrigger
              value="diagnostics"
              className="max-lg:!w-auto justify-start px-3 min-h-12 text-sm font-medium whitespace-nowrap shrink-0 rounded-sm text-muted-foreground hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none"
            >
              <Activity className="w-4 h-4 mr-2 shrink-0" />
              Diagnostics
            </TabsTrigger>
            {isMaster ? (
              <TabsTrigger
                value="recovery"
                className="max-lg:!w-auto justify-start px-3 min-h-12 text-sm font-medium whitespace-nowrap shrink-0 rounded-sm text-muted-foreground hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none"
              >
                <LifeBuoy className="w-4 h-4 mr-2 shrink-0" />
                Recovery
              </TabsTrigger>
            ) : null}
          </TabsList>

          <div className="flex-1 space-y-6">
            <TabsContent value="network" className="mt-0 space-y-6">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Satellite Uplink</CardTitle>
                    <CardDescription className="text-xs text-muted-foreground mt-1">Configure sync intervals and bandwidth limits.</CardDescription>
                  </div>
                  <Button variant="outline" onClick={handleForceSync} disabled={syncNowMutation.isPending} className="w-full xl:w-auto justify-center shrink-0">
                    <RefreshCw className="w-4 h-4 mr-2 shrink-0" />
                    Force Sync Now
                  </Button>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="sync-interval" className="text-xs font-semibold text-foreground uppercase tracking-wider">Sync Interval (Minutes)</Label>
                      <Input type="number" id="sync-interval"
                      value={syncInterval} onChange={e => setSyncInterval(e.target.value)} className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="max-bandwidth" className="text-xs font-semibold text-foreground uppercase tracking-wider">Max Bandwidth (Kbps)</Label>
                      <Input type="number" id="max-bandwidth"
                      value={maxBandwidth} onChange={e => setMaxBandwidth(e.target.value)} className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10" />
                    </div>
                  </div>
                  <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 pt-4 mt-4 border-t border-border">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">Pause Syncing (Port Mode)</p>
                      <p className="text-xs text-muted-foreground">Temporarily halt all shore-side telemetry and reports syncing.</p>
                    </div>
                    {/* The Switch component, same as the two toggles further
                        down this page — this one was hand-rolled as a
                        <div onClick>, so it took no keyboard focus, announced
                        nothing to a screen reader, and reported no checked
                        state. */}
                    <Switch
                      checked={pauseSyncing}
                      onCheckedChange={setPauseSyncing}
                      aria-label="Pause syncing (Port Mode)"
                    />
                  </div>
                </CardContent>
                <CardFooter className="border-t border-border p-4 flex flex-col sm:flex-row sm:justify-end gap-2">
                  <Button onClick={handleApplyNetworkSettings} disabled={updateSettingsMutation.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-semibold transition-all">
                    {updateSettingsMutation.isPending ? 'Applying...' : 'Apply Network Settings'}
                  </Button>
                </CardFooter>
              </Card>
            </TabsContent>

            <TabsContent value="storage" className="mt-0">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Data Retention</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Manage local SQLite database pruning.</CardDescription>
                </CardHeader>
                <CardContent className="pt-12 pb-12 flex flex-col items-center justify-center text-center space-y-4">
                  <Database className="w-8 h-8 text-muted-foreground mb-2" />
                  <p className="text-sm font-medium text-muted-foreground">Database using 14.2 MB of space.</p>
                  
                  <div className="flex flex-wrap gap-3 mt-6">
                    <Button variant="outline" className="border-border bg-background hover:bg-card text-foreground" onClick={() => window.open(`${API_ORIGIN}/system/backup/download`)}>
                      <Save className="w-4 h-4 mr-2" />
                      Download Full Backup
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="sensors" className="mt-0">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Hardware Sensors</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">
                    An onboard sensor source exposes readings over HTTP (GET {'{baseUrl}'}/telemetry, bearer API key) — used by
                    &quot;Pre-fill from Sensors&quot; on the report form. Unconfigured or unreachable always means no data, never fabricated numbers.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="sensor-base-url" className="text-xs font-semibold text-foreground uppercase tracking-wider">Base URL</Label>
                    <Input
                      type="text"
                      placeholder="https://sensors.example.vessel:8443"
                      id="sensor-base-url"
                      value={sensorBaseUrl}
                      onChange={(e) => setSensorBaseUrl(e.target.value)}
                      className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sensor-api-key" className="text-xs font-semibold text-foreground uppercase tracking-wider">API Key</Label>
                    <Input
                      type="password"
                      placeholder={sensorSource?.configured ? sensorSource.apiKey : 'Enter API key'}
                      id="sensor-api-key"
                      value={sensorApiKey}
                      onChange={(e) => setSensorApiKey(e.target.value)}
                      className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10"
                    />
                  </div>
                  <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 py-3 border-b border-border last:border-b-0">
                    <div>
                      <Label className="text-foreground">Enabled</Label>
                      <p className="text-xs text-muted-foreground">Disabled sources are never polled, even if configured.</p>
                    </div>
                    <Switch checked={sensorEnabled} onCheckedChange={setSensorEnabled} />
                  </div>
                  {testResult && (
                    <div className={`text-xs p-2.5 rounded-sm border ${testResult.ok ? 'bg-status-ok/10 text-status-ok border-status-ok/25' : 'bg-status-critical/10 text-status-critical border-status-critical/25'}`}>
                      {testResult.message}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Button
                      onClick={() => saveSensorMutation.mutate({ baseUrl: sensorBaseUrl, apiKey: sensorApiKey, enabled: sensorEnabled })}
                      disabled={saveSensorMutation.isPending || !sensorBaseUrl || !sensorApiKey}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-semibold transition-all"
                    >
                      {saveSensorMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
                      Save Sensor Config
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => testSensorMutation.mutate({ baseUrl: sensorBaseUrl, apiKey: sensorApiKey })}
                      disabled={testSensorMutation.isPending || !sensorBaseUrl}
                      className="border-border bg-background text-foreground hover:text-foreground rounded-sm h-9 text-sm"
                    >
                      {testSensorMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                      Test Connection
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="vms" className="mt-0">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">VMS Data Source</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">
                    Configures the VMS (voyage management system) service the report form&apos;s
                    &quot;Fetch voyage data&quot; button queries. The vessel pulls voyage plan and cargo
                    manifest data from this URL — nothing is ever pushed to the vessel unsolicited.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="vms-base-url" className="text-xs font-semibold text-foreground uppercase tracking-wider">Base URL</Label>
                    <Input
                      type="text"
                      placeholder="https://vms.example.com"
                      id="vms-base-url"
                      value={vmsBaseUrl}
                      onChange={(e) => setVmsBaseUrl(e.target.value)}
                      className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vms-api-key" className="text-xs font-semibold text-foreground uppercase tracking-wider">API Key</Label>
                    <Input
                      type="password"
                      placeholder={vmsSource?.configured ? `Enter a new key to change it (currently ${vmsSource.apiKey})` : 'Enter API key'}
                      id="vms-api-key"
                      value={vmsApiKey}
                      onChange={(e) => setVmsApiKey(e.target.value)}
                      className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10"
                    />
                  </div>
                  <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 py-3 border-b border-border last:border-b-0">
                    <div>
                      <Label className="text-foreground">Enabled</Label>
                      <p className="text-xs text-muted-foreground">Disabled sources are never queried, even if configured.</p>
                    </div>
                    <Switch checked={vmsEnabled} onCheckedChange={setVmsEnabled} />
                  </div>
                  {vmsTestResult && (
                    <div className={`text-xs p-2.5 rounded-sm border ${vmsTestResult.ok ? 'bg-status-ok/10 text-status-ok border-status-ok/25' : 'bg-status-critical/10 text-status-critical border-status-critical/25'}`}>
                      {vmsTestResult.message}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Button
                      onClick={() => saveVmsMutation.mutate({ baseUrl: vmsBaseUrl, apiKey: vmsApiKey, enabled: vmsEnabled })}
                      disabled={saveVmsMutation.isPending || !vmsBaseUrl || (!vmsSource?.configured && !vmsApiKey)}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-semibold transition-all"
                    >
                      {saveVmsMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
                      Save VMS Config
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => testVmsMutation.mutate({ baseUrl: vmsBaseUrl, apiKey: vmsApiKey })}
                      disabled={testVmsMutation.isPending || !vmsBaseUrl || (!vmsSource?.configured && !vmsApiKey)}
                      className="border-border bg-background text-foreground hover:text-foreground rounded-sm h-9 text-sm"
                    >
                      {testVmsMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                      Test Connection
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="diagnostics" className="mt-0">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">System Logs</CardTitle>
                </CardHeader>
                <CardContent className="pt-6 space-y-3">
                  {/* This panel used to show four hardcoded log lines dated
                      16 Aug 2026, presented as live output. sync.status
                      carries the real state — enrolment, last success, last
                      error and outbox depth — which is what a crew member
                      opening "Diagnostics" is actually trying to find out. */}
                  <dl className="divide-y divide-border rounded-sm border border-border bg-background text-sm">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-4 py-2.5">
                      <dt className="text-muted-foreground">Enrolled with shore</dt>
                      <dd>
                        {syncStatusQuery.isLoading ? (
                          <span className="text-muted-foreground">Checking&hellip;</span>
                        ) : (
                          <StatusBadge
                            role={syncStatusQuery.data?.enrolled ? 'ok' : 'warn'}
                            label={syncStatusQuery.data?.enrolled ? 'Enrolled' : 'Not enrolled'}
                          />
                        )}
                      </dd>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-4 py-2.5">
                      <dt className="text-muted-foreground">Queued for shore</dt>
                      <dd className="font-mono tabular-nums text-foreground">
                        {syncStatusQuery.data?.pendingCount ?? '—'}
                      </dd>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-4 px-4 py-2.5">
                      <dt className="text-muted-foreground shrink-0">Last successful sync</dt>
                      <dd className="font-mono text-xs text-foreground text-right">
                        {syncStatusQuery.data?.lastSuccess
                          ? new Date(syncStatusQuery.data.lastSuccess).toLocaleString()
                          : 'Never'}
                      </dd>
                    </div>
                    {syncStatusQuery.data?.lastError && (
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-1 sm:gap-4 px-4 py-2.5">
                        <dt className="text-muted-foreground shrink-0">Last error</dt>
                        <dd className="text-xs text-status-critical text-right break-words">
                          {syncStatusQuery.data.lastError}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <Button
                    variant="outline"
                    onClick={handleForceSync}
                    disabled={syncNowMutation.isPending}
                    className="w-full xl:w-auto justify-center shrink-0"
                  >
                    {syncNowMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {syncNowMutation.isPending ? 'Syncing\u2026' : 'Sync now'}
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {isMaster ? (
              <TabsContent value="recovery" className="mt-0 space-y-6">
                <RecoveryTab />
              </TabsContent>
            ) : null}
          </div>
        </div>
      </Tabs>
    </div>
  );
}
