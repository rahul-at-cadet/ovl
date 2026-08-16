'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Ship, Globe, Anchor, Save, Database, User, CheckCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useRouter } from 'next/navigation';

type Step = 'intro' | 'identity' | 'admin' | 'done';

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('intro');
  const { data: setupStatus, refetch } = trpc.setup.status.useQuery();
  
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
      alert('Failed to enroll. Please check inputs.');
    }
  };

  const handleCreateAdmin = async () => {
    try {
      const res = await createUserMutation.mutateAsync({ username, role: 'master', canSubmit: true });
      alert(`Master admin created! Temporary password: ${res.temporaryPassword}\nPlease save this password securely.`);
      setStep('done');
    } catch (e) {
      alert('Failed to create admin user.');
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-2xl mx-auto">
      <div className="border-b border-zinc-800/60 pb-6 text-center mt-8">
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-zinc-900 border border-zinc-800 shadow-sm rounded-xl">
            <Anchor className="w-8 h-8 text-blue-400" />
          </div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Vessel Node Initialization</h1>
        <p className="text-zinc-400 mt-1.5 text-sm font-medium">Configure this edge node with the vessel&apos;s identity and shore-side uplink.</p>
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
            <div key={s} className={`flex flex-col items-center gap-2 ${isActive ? 'text-blue-400' : isPast ? 'text-zinc-300' : 'text-zinc-600'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 text-sm font-bold ${
                isActive ? 'border-blue-400 bg-blue-400/10' : 
                isPast ? 'border-zinc-300 bg-zinc-800' : 
                'border-zinc-700 bg-zinc-900'
              }`}>
                {i + 1}
              </div>
              <span className="text-xs font-semibold uppercase tracking-wider">{s}</span>
            </div>
          )
        })}
      </div>

      {step === 'intro' && (
        <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
            <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200 flex items-center"><Database className="w-4 h-4 mr-2" /> Data Persistence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6 text-sm text-zinc-300">
            <p>Welcome to OVL Edge. This node operates in an occasionally-connected environment.</p>
            <p>All data is persisted locally in the configured SQLite database before being synchronized to shore. Ensure your host machine provides persistent storage for the data directory.</p>
          </CardContent>
          <CardFooter className="bg-zinc-950/40 border-t border-zinc-800/60 p-4 flex justify-end">
            <Button onClick={() => setStep('identity')} className="bg-blue-600 hover:bg-blue-500 text-white rounded-md h-9 text-sm font-semibold">
              Continue
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'identity' && (
        <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
            <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Identity Configuration</CardTitle>
            <CardDescription className="text-xs text-zinc-500">Must exactly match the shore-side registry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Vessel Name</Label>
                <div className="relative">
                  <Ship className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <Input disabled={setupStatus?.isConfigured} value={vesselName} onChange={e => setVesselName(e.target.value)} placeholder="e.g. Seawise Giant" className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10 disabled:opacity-70" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">IMO Number</Label>
                <Input disabled={setupStatus?.isConfigured} value={imoNumber} onChange={e => setImoNumber(e.target.value)} placeholder="e.g. 7381154" className="bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10 font-mono tracking-wider disabled:opacity-70" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Shore Uplink URL</Label>
                <div className="relative">
                  <Globe className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <Input disabled={setupStatus?.isConfigured} value={shoreUrl} onChange={e => setShoreUrl(e.target.value)} className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10 font-mono disabled:opacity-70" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Office API Key</Label>
                <Input disabled={setupStatus?.isConfigured} type="password" placeholder="ovl_prod_..." value={apiKey} onChange={e => setApiKey(e.target.value)} className="bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10 font-mono disabled:opacity-70" />
              </div>
            </div>
          </CardContent>
          <CardFooter className="bg-zinc-950/40 border-t border-zinc-800/60 p-4 flex justify-between items-center">
            <p className="text-xs text-zinc-500 flex items-center gap-1.5">
              Status: 
              <span className={setupStatus?.isConfigured ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
                {setupStatus?.isConfigured ? 'Configured' : 'Pending Setup'}
              </span>
            </p>
            <Button onClick={() => setupStatus?.isConfigured ? router.push('/') : handleEnroll()} disabled={(!vesselName || !imoNumber || !apiKey) && !setupStatus?.isConfigured || enrollMutation.isPending} className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 rounded-md h-9 text-sm font-semibold transition-all">
              <Save className="w-4 h-4 mr-2" />
              {enrollMutation.isPending ? 'Enrolling...' : setupStatus?.isConfigured ? 'Go to Dashboard' : 'Enroll & Continue'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'admin' && (
        <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
            <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200 flex items-center"><User className="w-4 h-4 mr-2" /> Master Admin</CardTitle>
            <CardDescription className="text-xs text-zinc-500">Create the initial master user to manage this node.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Username</Label>
              <Input value={username} onChange={e => setUsername(e.target.value)} className="bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10" />
            </div>
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 p-3 rounded-md">
              A temporary password will be generated for this user. You will be required to change it on first login.
            </p>
          </CardContent>
          <CardFooter className="bg-zinc-950/40 border-t border-zinc-800/60 p-4 flex justify-end">
            <Button onClick={handleCreateAdmin} disabled={!username || createUserMutation.isPending} className="bg-blue-600 hover:bg-blue-500 text-white rounded-md h-9 text-sm font-semibold">
              {createUserMutation.isPending ? 'Creating...' : 'Create Admin'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'done' && (
        <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
          <CardContent className="flex flex-col items-center justify-center p-12 text-center space-y-4">
            <CheckCircle className="w-16 h-16 text-green-400" />
            <h2 className="text-xl font-bold text-zinc-100">Setup Complete!</h2>
            <p className="text-sm text-zinc-400">The edge node is successfully enrolled and your master admin has been created.</p>
            <Button onClick={() => router.push('/')} className="mt-4 bg-zinc-100 text-zinc-900 hover:bg-white font-semibold">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
