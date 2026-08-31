'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { User, KeyRound, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { SparksLogo } from '@ovl/ui/components/sparks-logo';
import { Button } from '@ovl/ui/components/button';
import { API_ORIGIN } from '@/lib/api-origin';
import { trpc } from '@/lib/trpc';
import { humanErrorMessage } from '@ovl/ui/lib/mutation-errors';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // No account has ever been created on this node yet — a login form is
  // useless without one, and a first-time visitor has no way to know
  // /setup even exists. hasUsers is a public, no-auth check for exactly
  // this (see setup.status's own comment).
  const { data: setupStatus } = trpc.setup.status.useQuery();
  const needsSetup = setupStatus?.hasUsers === false;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    try {
      const res = await fetch(`${API_ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      
      if (!res.ok) {
        throw new Error('Invalid credentials');
      }
      
      const data = await res.json();
      
      if (data.mustChangePassword) {
        router.push('/account/force-password-change');
      } else {
        // Full page reload or router.push
        window.location.href = '/';
      }
    } catch (err: unknown) {
      // Never the raw message: a failed fetch here reads "Failed to fetch",
      // which tells the officer nothing about what to try next.
      setError(humanErrorMessage(err, 'Could not sign in. Try again in a moment.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[400px] z-10 p-4 space-y-4">
        {needsSetup && (
          <Card className="bg-primary/10 border-primary/30 rounded-sm">
            <CardContent className="pt-6 text-center space-y-3">
              <p className="text-sm text-foreground">
                No account exists on this node yet — set it up before signing in.
              </p>
              <Button
                onClick={() => router.push('/setup')}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-11 text-base font-medium"
              >
                Set Up This Vessel
              </Button>
            </CardContent>
          </Card>
        )}
        <Card className="bg-card border-border rounded-sm">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border">
            <div>
              <SparksLogo className="h-9 sm:h-11 mx-auto mb-1" />
              <CardDescription className="text-muted-foreground mt-2 text-sm">
                Secure Terminal Authentication
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="id" className="text-foreground text-xs uppercase tracking-wider font-medium">Crew ID</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    id="id"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. master"
                    className="pl-10 bg-card border-border focus-visible:ring-ring text-foreground rounded-sm h-12 text-base"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-foreground text-xs uppercase tracking-wider font-medium">Passcode</Label>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-10 bg-card border-border focus-visible:ring-ring text-foreground rounded-sm h-12 text-base"
                    required
                  />
                </div>
              </div>
              {error && (
                <div className="text-status-critical text-xs font-medium bg-status-critical/10 p-2 rounded-sm border border-status-critical/25">
                  {error}
                </div>
              )}
              {/* h-12 (48px) — a real touch target, not the app's usual
                  h-9: this is the button every crew member taps first,
                  possibly gloved and in a moving wheelhouse (maritime
                  touch-target guidance runs well above the 24px web
                  minimum for exactly that reason). */}
              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground transition-all rounded-sm h-12 text-base font-medium mt-4"
                disabled={isLoading}
              >
                {isLoading ? (
                  <ShieldCheck className="w-5 h-5 animate-spin" />
                ) : (
                  "Authenticate"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
