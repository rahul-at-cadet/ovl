'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'supertokens-auth-react/recipe/emailpassword';
import { Building2, KeyRound, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

export default function OfficeLoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  // Mirrors the original's SetupAdmin screen: shown only once, when no
  // account exists anywhere yet, in place of the normal sign-in form.
  // After the first Admin is created, hasAnyUser flips to true forever
  // and this branch can never be reached again for this deployment.
  const { data: setupStatus, isLoading: isSetupLoading } = trpc.setup.status.useQuery();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await signIn({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: password }
        ]
      });

      if (response.status === "OK") {
        router.push('/');
      } else {
        setError("Invalid email or password");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred during login");
    } finally {
      setIsLoading(false);
    }
  };

  if (isSetupLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Checking setup status...
      </div>
    );
  }

  if (setupStatus && !setupStatus.hasAnyUser) {
    return <FirstAdminSetup />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[400px] z-10 p-4">
        <Card className="bg-card border-border shadow-xl rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border/50">
            <div>
              <CardTitle className="text-xl font-medium tracking-tight text-foreground">
                Cadetlabs
              </CardTitle>
              <CardDescription className="text-muted-foreground mt-1 text-sm">
                Secure Office Authentication
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-foreground text-xs uppercase tracking-wider font-medium">Corporate Email</Label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    id="email" 
                    type="email" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@office.com" 
                    className="pl-9 bg-background/50 border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-foreground text-xs uppercase tracking-wider font-medium">Password</Label>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    id="password" 
                    type="password" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••" 
                    className="pl-9 bg-background/50 border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              {error && <div className="text-red-500 text-xs text-center">{error}</div>}
              <Button 
                type="submit" 
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground transition-all rounded-sm h-9 text-sm font-medium mt-4"
                disabled={isLoading}
              >
                {isLoading ? (
                  <ShieldCheck className="w-4 h-4 animate-spin" />
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FirstAdminSetup() {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState('');

  const createMutation = trpc.users.create.useMutation({
    onSuccess: (data) => setGeneratedPassword(data.temporaryPassword),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[420px] z-10 p-4">
        <Card className="bg-card border-border shadow-xl rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border/50">
            <CardTitle className="text-xl font-medium tracking-tight text-foreground">Cadetlabs</CardTitle>
            <CardDescription className="text-muted-foreground mt-1 text-sm">
              First-time setup — no account exists yet
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            {!generatedPassword ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Create the Admin account you&apos;ll sign in with — it can manage users, vessels, groups, and enrollment.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="admin-email" className="text-foreground text-xs uppercase tracking-wider font-medium">Email</Label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="admin-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@office.com"
                      className="pl-9 bg-background/50 border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    />
                  </div>
                </div>
                {createMutation.error && (
                  <div className="text-red-500 text-xs text-center">{createMutation.error.message}</div>
                )}
                <Button
                  onClick={() => createMutation.mutate({ username: email, roles: ['admin'] as any })}
                  disabled={!email || createMutation.isPending}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-medium"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create account'}
                </Button>
              </div>
            ) : (
              <div className="space-y-4 text-center">
                <div className="bg-emerald-500/10 text-emerald-400 p-3 rounded-md border border-emerald-500/20 text-sm">
                  Admin account created!
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Temporary Password (Reveal Once):</p>
                  <div className="text-lg font-mono tracking-wider bg-background/50 p-4 rounded border border-border select-all">
                    {generatedPassword}
                  </div>
                </div>
                <p className="text-xs text-amber-500/90">
                  Copy this now — it won&apos;t be shown again. You&apos;ll be asked to change it on first sign-in.
                </p>
                <Button
                  onClick={() => utils.setup.status.invalidate()}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-medium"
                >
                  Go to Sign In
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
