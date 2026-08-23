'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Ship, Globe, Save, Database, User, CheckCircle, Copy, Check, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { API_ORIGIN } from '@/lib/api-origin';
import { useRouter } from 'next/navigation';
import { useToastManager } from '@/components/ui/toast';

type Step = 'intro' | 'identity' | 'admin' | 'done';

export default function SetupPage() {
  const router = useRouter();
  const toastManager = useToastManager();
  const [step, setStep] = useState<Step>('intro');
  const { data: setupStatus, refetch } = trpc.setup.status.useQuery();
  const [createdPassword, setCreatedPassword] = useState('');
  const [copied, setCopied] = useState(false);
  
  // Identity form state
  const [vesselName, setVesselName] = useState('');
  const [imoNumber, setImoNumber] = useState('');
  const [shoreUrl, setShoreUrl] = useState('https://api.ovl.com');
  const [apiKey, setApiKey] = useState('');

  // Prefill when status is fetched
  useEffect(() => {
    if (setupStatus) {
      if (setupStatus.vesselName) setVesselName(setupStatus.vesselName);
      if (setupStatus.imoNumber) setImoNumber(setupStatus.imoNumber);
      if (setupStatus.shoreUrl) setShoreUrl(setupStatus.shoreUrl);
      if (setupStatus.apiKey) setApiKey(setupStatus.apiKey);
      
      if (setupStatus.isConfigured && step === 'intro') {
        setStep('identity');
      }
    }
  }, [setupStatus]);

  // Admin form state
  const [username, setUsername] = useState('master');
  
  const enrollMutation = trpc.setup.enroll.useMutation();
  const createUserMutation = trpc.users.create.useMutation();

  const handleEnroll = async () => {
    try {
      await enrollMutation.mutateAsync({ vesselName, imoNumber, shoreUrl, apiKey });
      await refetch();
      setStep('admin');
    } catch (e) {
      toastManager.add({ title: 'Failed to enroll', description: 'Please check your inputs and try again.', type: 'error' });
    }
  };

  const handleCreateAdmin = async () => {
    try {
      const res = await createUserMutation.mutateAsync({ username, role: 'master', canSubmit: true });
      // Establish a real session for the admin we just created, so they land
      // on the dashboard already logged in instead of hitting the login wall
      // the middleware now enforces on every other route.
      await fetch(`${API_ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password: res.temporaryPassword }),
      });
      setCreatedPassword(res.temporaryPassword);
    } catch (e) {
      toastManager.add({
        title: 'Failed to create admin user',
        description: e instanceof Error ? e.message : undefined,
        type: 'error',
      });
    }
  };

  const handleCopyPassword = () => {
    navigator.clipboard.writeText(createdPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-2xl mx-auto">
      <div className="border-b border-border/60 pb-6 text-center mt-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Vessel Node Initialization</h1>
        <p className="text-muted-foreground mt-1.5 text-sm font-medium">Configure this edge node with the vessel&apos;s identity and shore-side uplink.</p>
      </div>

      <div className="flex justify-between items-center mb-8 px-8">
        {['Intro', 'Identity', 'Admin', 'Done'].map((s, i) => {
          const isActive = 
            (step === 'intro' && i === 0) || 
            (step === 'identity' && i === 1) || 
            (step === 'admin' && i === 2) || 
            (step === 'done' && i === 3);
          const isPast = 
            (step !== 'intro' && i === 0) || 
            (step === 'admin' && i === 1) || 
            (step === 'done' && i <= 2);
            
          return (
            <div key={s} className={`flex flex-col items-center gap-2 ${isActive ? 'text-primary' : isPast ? 'text-foreground' : 'text-muted-foreground'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 text-sm font-bold ${
                isActive ? 'border-primary bg-primary/10' : 
                isPast ? 'border-zinc-300 bg-muted' : 
                'border-border bg-card'
              }`}>
                {i + 1}
              </div>
              <span className="text-xs font-semibold uppercase tracking-wider">{s}</span>
            </div>
          )
        })}
      </div>

      {step === 'intro' && (
        <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center"><Database className="w-4 h-4 mr-2" /> Data Persistence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6 text-sm text-foreground">
            <p>Welcome to Cadetlabs. This node operates in an occasionally-connected environment.</p>
            <p>All data is persisted locally in the configured SQLite database before being synchronized to shore. Ensure your host machine provides persistent storage for the data directory.</p>
          </CardContent>
          <CardFooter className="bg-background/40 border-t border-border/60 p-4 flex justify-end">
            <Button onClick={() => setStep('identity')} className="bg-primary hover:bg-primary/90 text-white rounded-md h-9 text-sm font-semibold">
              Continue
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'identity' && (
        <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Identity Configuration</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">Must exactly match the shore-side registry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">Vessel Name</Label>
                <div className="relative">
                  <Ship className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input disabled={setupStatus?.isConfigured} value={vesselName} onChange={e => setVesselName(e.target.value)} placeholder="e.g. Seawise Giant" className="pl-9 bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10 disabled:opacity-70" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">IMO Number</Label>
                <Input disabled={setupStatus?.isConfigured} value={imoNumber} onChange={e => setImoNumber(e.target.value)} placeholder="e.g. 7381154" className="bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10 font-mono tracking-wider disabled:opacity-70" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">Shore Uplink URL</Label>
                <div className="relative">
                  <Globe className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input disabled={setupStatus?.isConfigured} value={shoreUrl} onChange={e => setShoreUrl(e.target.value)} className="pl-9 bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10 font-mono disabled:opacity-70" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">Office API Key</Label>
                <Input disabled={setupStatus?.isConfigured} type="password" placeholder="ovl_prod_..." value={apiKey} onChange={e => setApiKey(e.target.value)} className="bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10 font-mono disabled:opacity-70" />
              </div>
            </div>
          </CardContent>
          <CardFooter className="bg-background/40 border-t border-border/60 p-4 flex justify-between items-center">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              Status: 
              <span className={setupStatus?.isConfigured ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
                {setupStatus?.isConfigured ? 'Configured' : 'Pending Setup'}
              </span>
            </p>
            <Button onClick={() => setupStatus?.isConfigured ? router.push('/') : handleEnroll()} disabled={(!vesselName || !imoNumber || !apiKey) && !setupStatus?.isConfigured || enrollMutation.isPending} className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20 rounded-md h-9 text-sm font-semibold transition-all">
              <Save className="w-4 h-4 mr-2" />
              {enrollMutation.isPending ? 'Enrolling...' : setupStatus?.isConfigured ? 'Go to Dashboard' : 'Enroll & Continue'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'admin' && (
        <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center"><User className="w-4 h-4 mr-2" /> Master Admin</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">Create the initial master user to manage this node.</CardDescription>
          </CardHeader>
          {!createdPassword ? (
            <>
              <CardContent className="space-y-4 pt-6">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">Username</Label>
                  <Input value={username} onChange={e => setUsername(e.target.value)} className="bg-background/80 border-border/80 focus-visible:ring-ring text-foreground text-sm h-10" />
                </div>
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 p-3 rounded-md">
                  A temporary password will be generated for this user. You will be required to change it on first login.
                </p>
              </CardContent>
              <CardFooter className="bg-background/40 border-t border-border/60 p-4 flex justify-end">
                <Button onClick={handleCreateAdmin} disabled={!username || createUserMutation.isPending} className="bg-primary hover:bg-primary/90 text-white rounded-md h-9 text-sm font-semibold">
                  {createUserMutation.isPending ? 'Creating...' : 'Create Admin'}
                </Button>
              </CardFooter>
            </>
          ) : (
            <>
              <CardContent className="space-y-4 pt-6 text-center">
                <div className="bg-emerald-500/10 text-emerald-400 p-3 rounded-md border border-emerald-500/20 text-sm">
                  Master admin created!
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Temporary Password (reveal once):</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xl font-mono tracking-wider bg-card p-4 rounded border border-border select-all text-foreground">
                      {createdPassword}
                    </code>
                    <Button variant="outline" onClick={handleCopyPassword} className="h-[52px] w-[52px] p-0 border-border bg-background text-foreground hover:text-foreground shrink-0">
                      {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-amber-400 flex items-center justify-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Make sure to copy this now. You won&apos;t be able to see it again.
                </p>
              </CardContent>
              <CardFooter className="bg-background/40 border-t border-border/60 p-4 flex justify-end">
                <Button onClick={() => setStep('done')} className="bg-primary hover:bg-primary/90 text-white rounded-md h-9 text-sm font-semibold">
                  Continue
                </Button>
              </CardFooter>
            </>
          )}
        </Card>
      )}

      {step === 'done' && (
        <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardContent className="flex flex-col items-center justify-center p-12 text-center space-y-4">
            <CheckCircle className="w-16 h-16 text-emerald-400" />
            <h2 className="text-xl font-bold text-foreground">Setup Complete!</h2>
            <p className="text-sm text-muted-foreground">The edge node is successfully enrolled and your master admin has been created.</p>
            <Button onClick={() => router.push('/')} className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90 font-semibold">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
