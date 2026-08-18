'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Settings, Globe, Shield, Key, Bell, KeyRound, Copy, CheckCircle2, Trash2 } from 'lucide-react';
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
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleGenerateKey = () => {
    createMutation.mutate({ label: newKeyLabel.trim() || 'Sync Key' });
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-6xl">
      <div className="border-b border-zinc-800/60 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Global Settings</h1>
        <p className="text-zinc-400 mt-1.5 text-sm font-medium">Configure shore-side system preferences, security policies, and edge integrations.</p>
      </div>

      <Tabs defaultValue="general" orientation="vertical" className="w-full">
        <div className="flex flex-col md:flex-row gap-8 w-full">
          <TabsList className="flex flex-col h-auto bg-transparent gap-2 w-64 shrink-0">
            <TabsTrigger 
              value="general" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-zinc-800/50 data-[state=active]:text-zinc-100 text-zinc-400 hover:bg-zinc-900/50 transition-all rounded-md"
            >
              <Settings className="w-4 h-4 mr-3" />
              General Config
            </TabsTrigger>
            <TabsTrigger 
              value="security" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-zinc-800/50 data-[state=active]:text-zinc-100 text-zinc-400 hover:bg-zinc-900/50 transition-all rounded-md"
            >
              <Shield className="w-4 h-4 mr-3" />
              Security & Auth
            </TabsTrigger>
            <TabsTrigger 
              value="apikeys" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-zinc-800/50 data-[state=active]:text-zinc-100 text-zinc-400 hover:bg-zinc-900/50 transition-all rounded-md"
            >
              <Key className="w-4 h-4 mr-3" />
              API Keys
            </TabsTrigger>
            <TabsTrigger 
              value="notifications" 
              className="w-full justify-start px-4 py-2.5 text-sm font-medium data-[state=active]:bg-zinc-800/50 data-[state=active]:text-zinc-100 text-zinc-400 hover:bg-zinc-900/50 transition-all rounded-md"
            >
              <Bell className="w-4 h-4 mr-3" />
              Notifications
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 space-y-6">
            <TabsContent value="general" className="mt-0 space-y-6">
              <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Organization Identity</CardTitle>
                  <CardDescription className="text-xs text-zinc-500">Update your company name and global locale settings.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="space-y-2 max-w-md">
                    <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Company Name</Label>
                    <Input defaultValue="Oceanic Vanguard Lines (OVL)" className="bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10" />
                  </div>
                  <div className="space-y-2 max-w-md">
                    <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Default Timezone</Label>
                    <Input defaultValue="UTC (Coordinated Universal Time)" className="bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10" />
                  </div>
                </CardContent>
                <CardFooter className="bg-zinc-950/40 border-t border-zinc-800/60 p-4 flex justify-end">
                  <Button className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-md h-9 text-sm font-semibold shadow-sm transition-all">
                    Save Changes
                  </Button>
                </CardFooter>
              </Card>
            </TabsContent>

            <TabsContent value="security" className="mt-0 space-y-6">
              <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">SSO & Authentication</CardTitle>
                  <CardDescription className="text-xs text-zinc-500">Configure corporate Single Sign-On and session policies.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 rounded-lg bg-zinc-950/50 border border-zinc-800/60">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-zinc-200">Enforce Multi-Factor Authentication</p>
                        <p className="text-xs text-zinc-500">Require MFA for all administrative personnel.</p>
                      </div>
                      <div className="h-5 w-9 rounded-full bg-emerald-500/20 flex items-center p-0.5 cursor-pointer border border-emerald-500/30 relative">
                         <div className="h-4 w-4 rounded-full bg-emerald-400 absolute right-0.5 shadow-sm" />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="apikeys" className="mt-0 space-y-6">
              <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">API Credentials</CardTitle>
                    <CardDescription className="text-xs text-zinc-500 mt-1">Manage keys for edge-node synchronization.</CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Key label (e.g. Production Sync Key)"
                      value={newKeyLabel}
                      onChange={(e) => setNewKeyLabel(e.target.value)}
                      className="bg-zinc-950/80 border-zinc-800/80 text-zinc-100 text-xs h-8 w-56"
                    />
                    <Button onClick={handleGenerateKey} disabled={createMutation.isPending} className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-md h-8 text-xs font-semibold shadow-sm transition-all px-3 shrink-0">
                      {createMutation.isPending ? 'Generating...' : 'Generate New Key'}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6 space-y-6">
                  {newRawToken && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-md space-y-2 mb-6">
                      <p className="text-sm text-emerald-400 font-medium">New API Key Generated</p>
                      <p className="text-xs text-emerald-500/80">Please copy this token now. You won't be able to see it again.</p>
                      <div className="flex gap-2 mt-2">
                        <Input readOnly value={newRawToken} className="bg-zinc-950/80 border-emerald-500/30 text-emerald-400 font-mono tracking-widest text-sm" />
                        <Button variant="outline" onClick={() => handleCopy(newRawToken, 'new')} className="border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 h-10 w-10 p-0 shrink-0">
                          {copied === 'new' ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                    </div>
                  )}

                  {isLoading ? (
                    <div className="text-center text-zinc-500 py-4 text-sm">Loading API keys...</div>
                  ) : apiKeys.length > 0 ? (
                    apiKeys.map((key) => (
                      <div key={key.id} className="space-y-2 pb-4 border-b border-zinc-800/40 last:border-0">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{key.label || 'API Key'}</Label>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate({ id: key.id })}
                            className="h-7 px-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" />
                            Revoke
                          </Button>
                        </div>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                            <Input
                              readOnly
                              type="password"
                              defaultValue="ovl_prod_xxxxxxxxxxxxxxxxxxxxxxxx"
                              className="pl-9 bg-zinc-950/80 border-zinc-800/80 text-zinc-400 text-sm h-10 font-mono tracking-widest"
                            />
                          </div>
                        </div>
                        <p className="text-[11px] text-zinc-500 mt-2">Created: {new Date(key.createdAt).toLocaleString()}</p>
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-zinc-500 py-4 text-sm">No active API keys.</div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="notifications" className="mt-0">
              <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Alert Preferences</CardTitle>
                  <CardDescription className="text-xs text-zinc-500">Configure how you receive system alerts.</CardDescription>
                </CardHeader>
                <CardContent className="pt-12 pb-12 flex flex-col items-center justify-center text-center">
                  <Globe className="w-8 h-8 text-zinc-600 mb-3" />
                  <p className="text-sm font-medium text-zinc-400">Notification settings coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </div>
      </Tabs>
    </div>
  );
}
