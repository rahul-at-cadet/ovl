'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Ship, Globe, Save, Database, User, CheckCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { validateImo } from '@/lib/imo';
import { useRouter } from 'next/navigation';
import { useToastManager } from '@ovl/ui/components/toast';

type Step = 'intro' | 'identity' | 'admin' | 'done';

export default function SetupPage() {
  const router = useRouter();
  const toastManager = useToastManager();
  const [step, setStep] = useState<Step>('intro');
  const { data: setupStatus, refetch } = trpc.setup.status.useQuery();

  // Identity form state. Name and IMO are no longer entered here: the
  // enrollment code identifies the vessel, and office sends its name and
  // IMO back on redemption. Asking the crew to retype an identity that
  // shore already holds only created a way for the two to disagree.
  const [shoreUrl, setShoreUrl] = useState('https://api.ovl.com');
  const [code, setCode] = useState('');

  // Prefill when status is fetched
  useEffect(() => {
    if (setupStatus) {
      if (setupStatus.shoreUrl) setShoreUrl(setupStatus.shoreUrl);

      if (setupStatus.isConfigured && step === 'intro') {
        setStep('identity');
      }
    }
  }, [setupStatus]);

  // Admin form state
  const [username, setUsername] = useState('master');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const redeemMutation = trpc.setup.redeem.useMutation();
  const createMasterMutation = trpc.setup.createMaster.useMutation();

  // 16 base32 characters, however the crew chose to type them — office
  // canonicalises before comparing, so dashes, spaces and case are all
  // accepted and this only checks there's a plausible amount of code.
  const codeCharCount = code.replace(/[^A-Za-z0-9]/g, '').length;
  const codeLooksComplete = codeCharCount === 16;

  const handleEnroll = async () => {
    try {
      const result = await redeemMutation.mutateAsync({ shoreUrl, code });
      await refetch();
      toastManager.add({
        title: `Enrolled as ${result.vesselName}`,
        description: `IMO ${result.imoNumber}. Identity and sync credential collected from the office.`,
        type: 'success',
      });
      setStep('admin');
    } catch (e: any) {
      toastManager.add({
        title: 'Could not enrol this node',
        // The server distinguishes a rejected code from an unreachable
        // office, and which one it was determines what the crew should
        // do next, so its message is surfaced rather than replaced.
        description: e?.message ?? 'Please check the code and try again.',
        type: 'error',
      });
    }
  };

  const handleCreateAdmin = async () => {
    try {
      // createMaster sets the session cookie itself (see trpc.router.ts) —
      // the admin lands on the dashboard already logged in, no separate
      // /auth/login call needed.
      await createMasterMutation.mutateAsync({ username, password });
      setStep('done');
    } catch (e) {
      toastManager.add({
        title: 'Failed to create admin user',
        description: e instanceof Error ? e.message : undefined,
        type: 'error',
      });
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-2xl mx-auto">
      <div className="border-b border-border pb-6 text-center mt-8">
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
                isPast ? 'border-border bg-muted' : 
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
        <Card className="bg-card border-border overflow-hidden rounded-sm">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center"><Database className="w-4 h-4 mr-2" /> Data Persistence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-6 text-sm text-foreground">
            <p>Welcome to Sparks. This node operates in an occasionally-connected environment.</p>
            <p>All data is persisted locally in the configured SQLite database before being synchronized to shore. Ensure your host machine provides persistent storage for the data directory.</p>
          </CardContent>
          <CardFooter className=" border-t border-border p-4 flex justify-end">
            <Button onClick={() => setStep('identity')} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-semibold">
              Continue
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'identity' && (
        <Card className="bg-card border-border overflow-hidden rounded-sm">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Enrol This Node</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              The office issues a single-use code for this vessel. The node collects its own name, IMO
              and sync credential when the code is redeemed — nothing else needs entering here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            {/* Once configured, identity is shore's answer rather than
                anything typed on board, so it's shown read-only. */}
            {setupStatus?.isConfigured ? (
              <div className="rounded-md border border-status-ok/25 bg-status-ok/10 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-status-ok">Enrolled</p>
                <p className="mt-1 text-sm text-foreground">
                  {setupStatus.vesselName || 'Unnamed vessel'}
                  {setupStatus.imoNumber ? (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">IMO {setupStatus.imoNumber}</span>
                  ) : null}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Identity is maintained by the office and refreshed on every sync.
                </p>
              </div>
            ) : null}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="setup-shore-url" className="text-xs font-semibold text-foreground uppercase tracking-wider">Shore Uplink URL</Label>
                <div className="relative">
                  <Globe className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input disabled={setupStatus?.isConfigured} id="setup-shore-url" value={shoreUrl} onChange={e => setShoreUrl(e.target.value)} className="pl-9 bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10 font-mono disabled:opacity-70" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-code" className="text-xs font-semibold text-foreground uppercase tracking-wider">Enrollment Code</Label>
                <Input
                  disabled={setupStatus?.isConfigured}
                  id="setup-code"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  spellCheck={false}
                  // Not masked: it's transcribed from paper on a bridge and
                  // is single-use, so being able to check what was typed
                  // matters more than hiding it.
                  className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10 font-mono uppercase tracking-widest disabled:opacity-70"
                />
                {!setupStatus?.isConfigured && codeCharCount > 0 && !codeLooksComplete ? (
                  <p className="text-xs text-muted-foreground">
                    {codeCharCount} of 16 characters — dashes, spaces and case don&apos;t matter.
                  </p>
                ) : null}
              </div>
            </div>
          </CardContent>
          <CardFooter className=" border-t border-border p-4 flex justify-between items-center">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              Status: 
              <span className={setupStatus?.isConfigured ? 'text-status-ok font-semibold' : 'text-status-warn font-semibold'}>
                {setupStatus?.isConfigured ? 'Configured' : 'Pending Setup'}
              </span>
            </p>
            <Button
              onClick={() => {
                if (!setupStatus?.isConfigured) return handleEnroll();
                // Identity can be configured (an earlier enroll) while no
                // admin account exists yet — only skip straight to the
                // dashboard once both are actually done, otherwise this
                // silently stranded a re-visiting officer with no way to
                // ever reach the admin step and create the account.
                if (setupStatus.hasUsers) return router.push('/');
                setStep('admin');
              }}
              disabled={((!shoreUrl.trim() || !codeLooksComplete) && !setupStatus?.isConfigured) || redeemMutation.isPending}
              className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-primary/20 rounded-sm h-9 text-sm font-semibold transition-all"
            >
              <Save className="w-4 h-4 mr-2" />
              {redeemMutation.isPending ? 'Enrolling...' : setupStatus?.isConfigured ? (setupStatus.hasUsers ? 'Go to Dashboard' : 'Continue to Admin Setup') : 'Enroll & Continue'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'admin' && (
        <Card className="bg-card border-border overflow-hidden rounded-sm">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center"><User className="w-4 h-4 mr-2" /> Master Admin</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">Create the initial master user to manage this node.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              <Label htmlFor="setup-username" className="text-xs font-semibold text-foreground uppercase tracking-wider">Username</Label>
              <Input id="setup-username" value={username} onChange={e => setUsername(e.target.value)} className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-password" className="text-xs font-semibold text-foreground uppercase tracking-wider">Password</Label>
              <Input type="password" id="setup-password" value={password} onChange={e => setPassword(e.target.value)} className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-confirm-password" className="text-xs font-semibold text-foreground uppercase tracking-wider">Confirm Password</Label>
              <Input type="password" id="setup-confirm-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="bg-card border-border focus-visible:ring-ring text-foreground text-sm h-10" />
              {confirmPassword.length > 0 && confirmPassword !== password ? (
                <p className="text-xs text-status-critical">Passwords don&apos;t match</p>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className=" border-t border-border p-4 flex justify-end">
            <Button
              onClick={handleCreateAdmin}
              disabled={!username || password.length < 8 || password !== confirmPassword || createMasterMutation.isPending}
              className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-semibold"
            >
              {createMasterMutation.isPending ? 'Creating...' : 'Create Admin'}
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 'done' && (
        <Card className="bg-card border-border overflow-hidden rounded-sm">
          <CardContent className="flex flex-col items-center justify-center p-12 text-center space-y-4">
            <CheckCircle className="w-16 h-16 text-status-ok" />
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
