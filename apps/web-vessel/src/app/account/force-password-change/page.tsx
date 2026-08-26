'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Button } from '@ovl/ui/components/button';
import { trpc } from '@/lib/trpc';

export default function ForcePasswordChangePage() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  
  const changePasswordMutation = trpc.users.changePassword.useMutation({
    onSuccess: () => {
      // Direct user back to dashboard on success
      window.location.href = '/';
    },
    onError: (err) => {
      setError(err.message);
    }
  });

  const handleSubmit = async (e: React.FormEvent) => {
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

    changePasswordMutation.mutate({ newPassword });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[400px] z-10 p-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <Card className="bg-card border-border rounded-sm">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border">
            <div className="flex justify-center mb-4">
              <div className="p-3 bg-status-warn/10 text-status-warn rounded-full border border-status-warn/25">
                <ShieldAlert className="w-6 h-6" />
              </div>
            </div>
            <div>
              <CardTitle className="text-xl font-medium tracking-tight text-foreground">
                Action Required
              </CardTitle>
              <CardDescription className="text-muted-foreground mt-1 text-sm">
                You must change your temporary password before continuing.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label className="text-foreground text-xs uppercase tracking-wider font-medium">New Passcode</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    type="password" 
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••" 
                    className="pl-9 bg-card border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-foreground text-xs uppercase tracking-wider font-medium">Confirm Passcode</Label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    type="password" 
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••" 
                    className="pl-9 bg-card border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              
              {error && (
                <div className="text-status-critical text-xs font-medium bg-status-critical/10 p-2 rounded-sm border border-status-critical/25">
                  {error}
                </div>
              )}
              
              <Button 
                type="submit" 
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground transition-all rounded-sm h-9 text-sm font-medium mt-4 shadow-primary/20"
                disabled={changePasswordMutation.isPending}
              >
                {changePasswordMutation.isPending ? 'Updating...' : 'Update & Continue'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
