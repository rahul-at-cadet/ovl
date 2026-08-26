'use client';

import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@ovl/ui/components/dialog';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { useToastManager } from '@ovl/ui/components/toast';
import { trpc } from '@/lib/trpc';

/**
 * Voluntary password change, from the user menu.
 *
 * The vessel API has exposed users.changePassword all along, but the only
 * route to it in this app was the *forced* interstitial after a Master issued
 * a temporary password — a crew member who simply wanted to change their own
 * password had no way to do it without an officer resetting it for them
 * first. The original app (ovl/web/vessel/src/screens/account/
 * ChangePasswordDialog.tsx) offers it from the user menu; this restores that.
 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toastManager = useToastManager();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.users.changePassword.useMutation({
    // The dialog shows its own error inline, next to the fields it refers to.
    meta: { silentError: true },
    onSuccess: () => {
      toastManager.add({ title: 'Password changed', type: 'success' });
      handleOpenChange(false);
    },
    onError: (err) => setError(err.message),
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
    }
    onOpenChange(next);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Those two passwords don't match.");
      return;
    }
    mutation.mutate({ newPassword });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px] bg-background border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-foreground">Change password</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            This changes your password on this vessel terminal only.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-foreground">
              New password
            </Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="pl-9 h-11 text-base"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-foreground">
              Confirm new password
            </Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="pl-9 h-11 text-base"
                required
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-status-critical">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              {mutation.isPending ? 'Changing…' : 'Change password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
