'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'supertokens-auth-react/recipe/emailpassword';
import { Building2, KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Button } from '@ovl/ui/components/button';
import { SparksMark } from '@/components/layout/SparksLogo';
import { trpc } from '@/lib/trpc';
import { API_ORIGIN } from '@/lib/api-origin';

export default function OfficeLoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  // Set once a login succeeds with mustChangePassword true (a temp
  // password, either first-issued or admin-reset) — swaps the form below
  // for a forced change instead of continuing to the dashboard. Keeps the
  // just-typed password in state as `password` below, since the
  // self-service change endpoint requires the current one and there's
  // nowhere else to get it once the temp-password login form is gone.
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

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
        // signIn() only confirms the SuperTokens session; whether this is
        // a temp password needing a forced change lives in this app's own
        // profile table, so that requires a separate authenticated call.
        const meRes = await fetch(`${API_ORIGIN}/users/me`);
        const me = meRes.ok ? await meRes.json() : null;
        if (me?.mustChangePassword) {
          setMustChangePassword(true);
        } else {
          router.push('/');
        }
      } else {
        setError("Invalid email or password");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred during login");
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${API_ORIGIN}/users/me/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || 'Failed to update password');
      }
      window.location.href = '/';
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred updating the password');
    } finally {
      setIsLoading(false);
    }
  };

  if (mustChangePassword) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-full max-w-[400px] z-10 p-4">
          <Card className="bg-card border-border shadow-sm rounded-md">
            <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border">
              <div className="flex justify-center mb-2">
                <div className="p-3 bg-status-warn/10 text-status-warn rounded-full border border-status-warn/25">
                  <ShieldAlert className="w-6 h-6" />
                </div>
              </div>
              <CardTitle className="text-xl font-medium tracking-tight text-foreground">Action Required</CardTitle>
              <CardDescription className="text-muted-foreground mt-1 text-sm">
                You must change your temporary password before continuing.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-foreground text-xs uppercase tracking-wider font-medium">New Password</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="••••••••"
                      className="pl-9 bg-card border-border text-foreground rounded-md h-9 text-sm"
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-foreground text-xs uppercase tracking-wider font-medium">Confirm Password</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                      className="pl-9 bg-card border-border text-foreground rounded-md h-9 text-sm"
                      required
                    />
                  </div>
                </div>
                {error && <div className="text-status-critical text-xs text-center">{error}</div>}
                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-medium mt-4"
                  disabled={isLoading}
                >
                  {isLoading ? 'Updating...' : 'Update & Continue'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

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
        <Card className="bg-card border-border shadow-sm rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border">
            <div>
              <SparksMark className="h-10 w-10 mx-auto mb-2" />
              <CardTitle className="text-xl font-medium tracking-tight text-foreground">
                Sparks
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
                    className="pl-9 bg-card border-border text-foreground rounded-md h-9 text-sm"
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
                    className="pl-9 bg-card border-border text-foreground rounded-md h-9 text-sm"
                    required
                  />
                </div>
              </div>
              {error && <div className="text-status-critical text-xs text-center">{error}</div>}
              <Button 
                type="submit" 
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground transition-all rounded-md h-9 text-sm font-medium mt-4"
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
    // The first-admin form shows this error under the fields itself.
    meta: { silentError: true },
    onSuccess: (data) => setGeneratedPassword(data.temporaryPassword),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[420px] z-10 p-4">
        <Card className="bg-card border-border shadow-sm rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border">
            <SparksMark className="h-10 w-10 mx-auto mb-2" />
            <CardTitle className="text-xl font-medium tracking-tight text-foreground">Sparks</CardTitle>
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
                      className="pl-9 bg-card border-border text-foreground rounded-md h-9 text-sm"
                    />
                  </div>
                </div>
                {createMutation.error && (
                  <div className="text-status-critical text-xs text-center">{createMutation.error.message}</div>
                )}
                <Button
                  onClick={() => createMutation.mutate({ username: email, roles: ['admin'] as any })}
                  disabled={!email || createMutation.isPending}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-medium"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create account'}
                </Button>
              </div>
            ) : (
              <div className="space-y-4 text-center">
                <div className="bg-status-ok/10 text-status-ok p-3 rounded-md border border-status-ok/25 text-sm">
                  Admin account created!
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Temporary Password (Reveal Once):</p>
                  <div className="text-lg font-mono tracking-wider bg-card p-4 rounded border border-border select-all">
                    {generatedPassword}
                  </div>
                </div>
                <p className="text-xs text-status-warn/90">
                  Copy this now — it won&apos;t be shown again. You&apos;ll be asked to change it on first sign-in.
                </p>
                <Button
                  onClick={() => utils.setup.status.invalidate()}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-medium"
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
