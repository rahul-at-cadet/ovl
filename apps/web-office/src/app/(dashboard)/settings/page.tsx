'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import { Settings, Globe, Shield, Key, Bell, KeyRound, Copy, CheckCircle2, Trash2, Ship, Pencil, X, Loader2, Server, Database, Clock } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

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

    // Deliberately does NOT dismiss the new-token banner. Copying is not
    // proof the token was captured: clipboard writes fail silently in
    // non-secure contexts (hence the execCommand fallback above), and the
    // paste can still land somewhere the operator loses. Since the token
    // is unrecoverable once dismissed, clearing it stays an explicit act
    // — the Done button — rather than a side effect of clicking copy.
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
    // Fixed to the viewport with the panel scrolling internally, matching
    // Vessels/Reports/Users. Without it the API Keys tab grew the whole
    // page — the tab rail scrolled away with the content, so on a
    // deployment with a real number of keys you lost the navigation and
    // the "Generate New Key" control the moment you scrolled down to
    // read the list.
    <div className="h-[calc(100dvh-136px)] flex flex-col space-y-6 overflow-hidden max-w-6xl">
      <div className="border-b border-border pb-6 shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Global Settings</h1>
        <p className="text-muted-foreground mt-1.5 text-sm font-medium">Configure shore-side system preferences, security policies, and edge integrations.</p>
      </div>

      <Tabs defaultValue="general" orientation="vertical" className="w-full flex-1 min-h-0">
        <div className="flex flex-col md:flex-row gap-8 w-full h-full min-h-0">
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

          {/* min-h-0 is load-bearing: without it this flex child adopts
              its content's height instead of the row's, so the API Keys
              card grew past the viewport and its own overflow-y-auto had
              nothing left to scroll. */}
          <div className="flex-1 min-h-0 flex flex-col space-y-6">
            <TabsContent value="general" className="mt-0 space-y-6">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
                <CardHeader className="border-b border-border pb-4 bg-card">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Organization Identity</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Update your company name and global locale settings.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="space-y-2 max-w-md">
                    <Label htmlFor="company-name" className="text-xs font-semibold text-foreground uppercase tracking-wider">Company Name</Label>
                    <Input id="company-name" defaultValue="Oceanic Vanguard Lines (OVL)" className="bg-card border-border text-foreground text-sm h-10" />
                  </div>
                  <div className="space-y-2 max-w-md">
                    <Label htmlFor="default-timezone" className="text-xs font-semibold text-foreground uppercase tracking-wider">Default Timezone</Label>
                    <Input id="default-timezone" defaultValue="UTC (Coordinated Universal Time)" className="bg-card border-border text-foreground text-sm h-10" />
                  </div>
                </CardContent>
                <CardFooter className="bg-card border-t border-border p-4 flex justify-end">
                  <Button className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm transition-all">
                    Save Changes
                  </Button>
                </CardFooter>
              </Card>
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

            <TabsContent value="apikeys" className="mt-0 min-h-0 flex-1 flex flex-col">
              <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md flex flex-col min-h-0 flex-1">
                <CardHeader className="border-b border-border pb-4 bg-card flex flex-row items-center justify-between shrink-0">
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

                {/* Pinned outside the scroll container, not inside it: the
                    token is shown exactly once and cannot be recovered, so
                    it must not be able to scroll out of view while the
                    operator is reading it across to a vessel. */}
                {newRawToken && (
                  <div className="shrink-0 border-b border-border px-(--card-spacing) pt-4 pb-4">
                    <div className="bg-status-ok/10 border border-status-ok/25 p-4 rounded-md space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm text-status-ok font-medium">New API Key Generated</p>
                          <p className="text-xs text-status-ok/80">Please copy this token now. You won&apos;t be able to see it again.</p>
                        </div>
                        {/* An explicit dismiss, because copying isn't the only
                            way someone takes the token down — selecting the
                            text by hand or reading it across to another
                            machine leaves the banner with no way to clear it. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setNewRawToken(null)}
                          className="h-7 px-2 -mt-1 -mr-1 text-status-ok/70 hover:text-status-ok hover:bg-status-ok/10 shrink-0"
                        >
                          Done
                        </Button>
                      </div>
                      <div className="flex gap-2 mt-2">
                        <Input readOnly value={newRawToken} className="bg-card border-status-ok/30 text-status-ok font-mono tracking-widest text-sm" />
                        <Button variant="outline" onClick={() => handleCopy(newRawToken, 'new')} className="border-status-ok/30 bg-status-ok/10 hover:bg-status-ok/20 text-status-ok h-10 w-10 p-0 shrink-0">
                          {copied === 'new' ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                <CardContent className="pt-6 space-y-6 flex-1 min-h-0 overflow-y-auto">
                  {/* One compact row per key. The previous layout gave each
                      key a full-width masked password field, which was
                      pure decoration — the token is unrecoverable by
                      design, so the dots represented nothing and implied a
                      reveal that cannot exist. What an operator actually
                      needs here is to tell keys apart and revoke the right
                      one, so the row carries the label, a stable
                      fingerprint, and its dates instead. */}
                  {isLoading ? (
                    <div className="text-center text-muted-foreground py-4 text-sm">Loading API keys...</div>
                  ) : apiKeys.length > 0 ? (
                    <div className="divide-y divide-border rounded-md border border-border">
                      {apiKeys.map((key) => (
                        <div
                          key={key.id}
                          className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                        >
                          <KeyRound className="size-4 shrink-0 text-muted-foreground" />

                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="truncate text-sm font-medium text-foreground">
                                {key.label || 'API Key'}
                              </span>
                              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
                                {key.fingerprint}
                              </code>
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              Created {new Date(key.createdAt).toLocaleDateString()}
                              {key.lastUsedAt ? (
                                <> · last used {new Date(key.lastUsedAt).toLocaleDateString()}</>
                              ) : (
                                <> · never used</>
                              )}
                            </div>
                          </div>

                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate({ id: key.id })}
                            className="h-7 shrink-0 px-2 text-muted-foreground hover:bg-status-critical/10 hover:text-status-critical"
                          >
                            <Trash2 className="mr-1 w-3.5 h-3.5" />
                            Revoke
                          </Button>
                        </div>
                      ))}
                    </div>
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
