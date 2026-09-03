'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import { Settings, Globe, Shield, Bell, Trash2, Ship, Pencil, X, Loader2, Server, Database, Clock } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export default function SettingsPage() {
  const utils = trpc.useUtils();


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
    // Vessels/Reports/Users. Without it a long tab grew the whole page and
    // the tab rail scrolled away with the content, so you lost the
    // navigation the moment you scrolled down to read a list.
    <div className="h-[calc(100dvh-96px)] lg:h-[calc(100dvh-112px)] flex flex-col space-y-6 overflow-hidden max-w-6xl">
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
            {/* Hidden rather than shown-and-broken for non-admins: the
                whole tab is admin-gated server-side, so offering it to a
                viewer only produces an empty list and a button that
                403s. Matches the original, which hides Administration
                from non-admins outright. */}
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
              its content's height instead of the row's, so a long card
              grows past the viewport and its own overflow-y-auto has
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
