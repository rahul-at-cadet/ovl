'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import { Settings, Globe, Shield, Key, Bell, KeyRound, Copy, CheckCircle2, Trash2, Ship, Pencil, X, Loader2, Server, Database, Clock } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { GeneralSettingsTab } from './GeneralSettingsTab';

export default function SettingsPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [newRawToken, setNewRawToken] = useState<string | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState('');

  const utils = trpc.useUtils();
  const { data: apiKeys = [], isLoading } = trpc.apiKeys.list.useQuery();

  const createMutation = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      utils.apiKeys.list.invalidate();
      setNewRawToken(data.rawToken);
      setNewKeyLabel('');
    }
  });

  const revokeMutation = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => utils.apiKeys.list.invalidate(),
  });

  const handleCopy = (text: string, id: string) => {
    // navigator.clipboard requires a secure context (HTTPS or localhost)
    // — over plain HTTP on a real host (this deployment's common case),
    // it's simply undefined in most browsers, so the call above threw
    // synchronously with nothing catching it, silently doing nothing.
    // document.execCommand('copy') has no such restriction, so it's the
    // fallback here rather than the primary path failing invisibly.
    const copyViaFallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(copyViaFallback);
    } else {
      copyViaFallback();
    }
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleGenerateKey = () => {
    createMutation.mutate({ label: newKeyLabel.trim() || 'Sync Key' });
  };

  // Groups are free-form tags on each vessel's own profile (architecture
  // 12.4), not a first-class entity — there's no dedicated groups list
  // to fetch, so the catalog is derived the same way the fleet's own
  // group filter already derives it: the union of every vessel's tags.
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
  const groupCounts = new Map<string, number>();
  for (const v of vessels) for (const g of (v.groups as string[] | undefined) ?? []) groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  const groupRows = [...groupCounts.entries()].map(([name, vesselCount]) => ({ name, vesselCount })).sort((a, b) => a.name.localeCompare(b.name));

  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameGroupMutation = trpc.vessels.renameGroup.useMutation({
    onSuccess: () => {
      utils.vessels.list.invalidate();
      setRenamingGroup(null);
    },
  });
  const deleteGroupMutation = trpc.vessels.deleteGroup.useMutation({
    onSuccess: () => utils.vessels.list.invalidate(),
  });

  const { data: systemStatus } = trpc.system.get.useQuery(undefined, { refetchInterval: 30_000 });

  return (
    <div className="space-y-8 max-w-6xl">
      <div className="border-b border-border pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Global Settings</h1>
        <p className="text-muted-foreground mt-1.5 text-sm font-medium">Configure shore-side system preferences, security policies, and edge integrations.</p>
      </div>

      <Tabs defaultValue="general" orientation="vertical" className="w-full">
        <div className="flex flex-col md:flex-row gap-8 w-full">
          <TabsList className="flex flex-col h-auto bg-transparent gap-2 w-64 shrink-0">
            <TabsTrigger 
              value="general" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground text-muted-foreground hover:bg-card transition-all rounded-md"
            >
              <Settings className="w-4 h-4 mr-3" />
              General Config
            </TabsTrigger>
            <TabsTrigger 
              value="security" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground text-muted-foreground hover:bg-card transition-all rounded-md"
            >
              <Shield className="w-4 h-4 mr-3" />
              Security & Auth
            </TabsTrigger>
            <TabsTrigger 
              value="apikeys" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground text-muted-foreground hover:bg-card transition-all rounded-md"
            >
              <Key className="w-4 h-4 mr-3" />
              API Keys
            </TabsTrigger>
            <TabsTrigger
              value="notifications"
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground text-muted-foreground hover:bg-card transition-all rounded-md"
            >
              <Bell className="w-4 h-4 mr-3" />
              Notifications
            </TabsTrigger>
            <TabsTrigger
              value="groups"
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground text-muted-foreground hover:bg-card transition-all rounded-md"
            >
              <Ship className="w-4 h-4 mr-3" />
              Vessel Groups
            </TabsTrigger>
            <TabsTrigger
              value="system"
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground text-muted-foreground hover:bg-card transition-all rounded-md"
            >
              <Server className="w-4 h-4 mr-3" />
              System
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 space-y-6">
            <TabsContent value="general" className="mt-0 space-y-6">
              <GeneralSettingsTab />
            </TabsContent>

            <TabsContent value="security" className="mt-0 space-y-6">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
                <CardHeader className="border-b border-border pb-4 bg-card">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">SSO & Authentication</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Configure corporate Single Sign-On and session policies.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 rounded-md bg-card border border-border">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">Enforce Multi-Factor Authentication</p>
                        <p className="text-xs text-muted-foreground">Require MFA for all administrative personnel.</p>
                      </div>
                      <div className="h-5 w-9 rounded-full bg-status-ok/20 flex items-center p-0.5 cursor-pointer border border-status-ok/30 relative">
                         <div className="h-4 w-4 rounded-full bg-status-ok absolute right-0.5 shadow-sm" />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="apikeys" className="mt-0 space-y-6">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
                <CardHeader className="border-b border-border pb-4 bg-card flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-semibold tracking-tight text-foreground">API Credentials</CardTitle>
                    <CardDescription className="text-xs text-muted-foreground mt-1">Manage keys for edge-node synchronization.</CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Key label (e.g. Production Sync Key)"
                      value={newKeyLabel}
                      onChange={(e) => setNewKeyLabel(e.target.value)}
                      className="bg-card border-border text-foreground text-xs h-8 w-56"
                    />
                    <Button onClick={handleGenerateKey} disabled={createMutation.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-8 text-xs font-semibold shadow-sm transition-all px-3 shrink-0">
                      {createMutation.isPending ? 'Generating...' : 'Generate New Key'}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6 space-y-6">
                  {newRawToken && (
                    <div className="bg-status-ok/10 border border-status-ok/25 p-4 rounded-md space-y-2 mb-6">
                      <p className="text-sm text-status-ok font-medium">New API Key Generated</p>
                      <p className="text-xs text-status-ok/80">Please copy this token now. You won't be able to see it again.</p>
                      <div className="flex gap-2 mt-2">
                        <Input readOnly value={newRawToken} className="bg-card border-status-ok/30 text-status-ok font-mono tracking-widest text-sm" />
                        <Button variant="outline" onClick={() => handleCopy(newRawToken, 'new')} className="border-status-ok/30 bg-status-ok/10 hover:bg-status-ok/20 text-status-ok h-10 w-10 p-0 shrink-0">
                          {copied === 'new' ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                    </div>
                  )}

                  {isLoading ? (
                    <div className="text-center text-muted-foreground py-4 text-sm">Loading API keys...</div>
                  ) : apiKeys.length > 0 ? (
                    apiKeys.map((key) => (
                      <div key={key.id} className="space-y-2 pb-4 border-b border-border last:border-0">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">{key.label || 'API Key'}</Label>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate({ id: key.id })}
                            className="h-7 px-2 text-muted-foreground hover:text-status-critical hover:bg-status-critical/10"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" />
                            Revoke
                          </Button>
                        </div>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                              readOnly
                              type="password"
                              defaultValue="ovl_prod_xxxxxxxxxxxxxxxxxxxxxxxx"
                              className="pl-9 bg-card border-border text-muted-foreground text-sm h-10 font-mono tracking-widest"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">Created: {new Date(key.createdAt).toLocaleString()}</p>
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-muted-foreground py-4 text-sm">No active API keys.</div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="notifications" className="mt-0">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
                <CardHeader className="border-b border-border pb-4 bg-card">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Alert Preferences</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Configure how you receive system alerts.</CardDescription>
                </CardHeader>
                <CardContent className="pt-12 pb-12 flex flex-col items-center justify-center text-center">
                  <Globe className="w-8 h-8 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">Notification settings coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="groups" className="mt-0">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
                <CardHeader className="border-b border-border pb-4 bg-card">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Vessel Groups</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">
                    Groups are tags on each vessel&apos;s own profile, not a separate list — used to scope cadence rules and regulatory profiles to a subset of the fleet.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-6">
                  {groupRows.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">
                      No groups yet — add one from a vessel&apos;s profile in Vessel Management.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {groupRows.map((g) => (
                        <div key={g.name} className="flex items-center justify-between gap-3 py-3">
                          {renamingGroup === g.name ? (
                            <div className="flex items-center gap-2 flex-1">
                              <Input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                className="bg-background border-border h-8 text-sm max-w-xs"
                              />
                              <Button
                                size="sm"
                                disabled={!renameValue.trim() || renameGroupMutation.isPending}
                                onClick={() => renameGroupMutation.mutate({ from: g.name, to: renameValue.trim() })}
                                className="bg-primary hover:bg-primary/90 h-8"
                              >
                                {renameGroupMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
                              </Button>
                              <Button size="icon" variant="ghost" aria-label="Cancel rename" className="h-8 w-8 text-muted-foreground" onClick={() => setRenamingGroup(null)}>
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-3">
                                <Ship className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-foreground">{g.name}</span>
                                <span className="text-xs text-muted-foreground">{g.vesselCount} vessel{g.vesselCount === 1 ? '' : 's'}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                  onClick={() => { setRenamingGroup(g.name); setRenameValue(g.name); }}
                                  aria-label={`Rename group ${g.name}`}
                                  title="Rename"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-muted-foreground hover:text-status-critical"
                                  disabled={deleteGroupMutation.isPending}
                                  onClick={() => deleteGroupMutation.mutate({ group: g.name })}
                                  aria-label={`Delete group ${g.name}`}
                                  title="Remove this tag from every vessel"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="system" className="mt-0">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
                <CardHeader className="border-b border-border pb-4 bg-card">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">System Status</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Live, read from this office instance directly — nothing here is a stored snapshot.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {!systemStatus ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">Loading…</div>
                  ) : (
                    <div className="divide-y divide-border">
                      <div className="flex items-center gap-4 px-5 py-4">
                        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                          <Server className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-foreground">ovl-office</div>
                          <div className="text-xs text-muted-foreground">build version</div>
                        </div>
                        <div className="text-sm font-mono text-foreground">{systemStatus.version}</div>
                      </div>
                      <div className="flex items-center gap-4 px-5 py-4">
                        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                          <Database className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-foreground">Database</div>
                          <div className="text-xs text-muted-foreground">PostgreSQL connectivity</div>
                        </div>
                        <div className={`text-sm font-mono ${systemStatus.databaseReachable ? 'text-status-ok' : 'text-status-critical'}`}>
                          {systemStatus.databaseReachable ? 'Reachable' : 'Unreachable'}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 px-5 py-4 opacity-75">
                        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                          <Clock className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-foreground">Background jobs</div>
                          <div className="text-xs text-muted-foreground">No job queue is wired up in this deployment — no health signal to show here yet</div>
                        </div>
                        <div className="text-sm font-mono text-muted-foreground">Not wired yet</div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </div>
      </Tabs>
    </div>
  );
}
