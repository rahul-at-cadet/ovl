'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@ovl/ui/components/dialog';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { UserPlus, KeyRound, ShieldCheck, Ban, RotateCcw, Clock, CheckCircle2, RadioTower } from 'lucide-react';
import { CopyField } from '@ovl/ui/components/copy-field';
import { trpc } from '@/lib/trpc';

// vessel/auth.Role's own string values (architecture 9.3), same fixed
// six-role set mirrored by the port's field-policy and sync logic
// elsewhere — "master" is deliberately excluded: it's created once during
// the vessel's own local setup wizard, never remotely (see
// VesselUsersService.assertNotMaster on the office side and
// AuthService.createLocalUser's matching check on the vessel side).
const VESSEL_ROLES: { value: string; label: string }[] = [
  { value: 'chiefOfficer', label: 'Chief Officer' },
  { value: 'secondOfficer', label: 'Second Officer' },
  { value: 'thirdOfficer', label: 'Third Officer' },
  { value: 'chiefEngineer', label: 'Chief Engineer' },
  { value: 'secondEngineer', label: 'Second Engineer' },
];

function vesselRoleLabel(value: string): string {
  if (value === 'master') return 'Master';
  return VESSEL_ROLES.find((r) => r.value === value)?.label ?? value;
}

function commandLabel(cmd: { action: string; role?: string | null }): string {
  switch (cmd.action) {
    case 'create':
      return 'Create account';
    case 'resetPassword':
      return 'Reset password';
    case 'setRole':
      return `Set role to ${vesselRoleLabel(cmd.role ?? '')}`;
    case 'setActive':
      return 'Change active state';
    case 'setCanSubmit':
      return 'Change submit permission';
    default:
      return cmd.action;
  }
}

type CommandProgress = {
  role: 'ok' | 'info' | 'warn';
  label: string;
  /** Whether a password issued by this command works on the vessel yet. */
  live: boolean;
};

function commandProgress(cmd: { appliedAt: string | null; fetchedAt: string | null }): CommandProgress {
  if (cmd.appliedAt) return { role: 'ok', label: 'Applied on vessel', live: true };
  if (cmd.fetchedAt) return { role: 'info', label: 'Delivered — applying', live: false };
  return { role: 'warn', label: 'Queued — awaiting next sync', live: false };
}

function commandStatus(cmd: { appliedAt: string | null; fetchedAt: string | null }): string {
  return commandProgress(cmd).label;
}

interface VesselUsersDialogProps {
  vesselId: string;
  vesselName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VesselUsersDialog({ vesselId, vesselName, open, onOpenChange }: VesselUsersDialogProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [addUsername, setAddUsername] = useState('');
  const [addRole, setAddRole] = useState(VESSEL_ROLES[0].value);
  const [roleTarget, setRoleTarget] = useState<{ username: string } | null>(null);
  const [roleChoice, setRoleChoice] = useState(VESSEL_ROLES[0].value);
  const [deactivateTarget, setDeactivateTarget] = useState<{ username: string } | null>(null);
  const [revealed, setRevealed] = useState<{ username: string; temporaryPassword: string; commandId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const { data: roster = [] } = trpc.vessels.users.list.useQuery({ vesselId }, { enabled: open });
  const { data: commands = [] } = trpc.vessels.users.listCommands.useQuery(
    { vesselId },
    { enabled: open, refetchInterval: open ? 10_000 : false },
  );

  const invalidate = () => {
    utils.vessels.users.list.invalidate({ vesselId });
    utils.vessels.users.listCommands.invalidate({ vesselId });
  };

  const createMutation = trpc.vessels.users.create.useMutation({
    onSuccess: (result) => {
      invalidate();
      setRevealed({ username: result.command.username, temporaryPassword: result.temporaryPassword, commandId: result.command.id });
    },
    onError: (err) => setError(err.message),
  });
  const resetPasswordMutation = trpc.vessels.users.resetPassword.useMutation({
    onSuccess: (result) => {
      invalidate();
      setRevealed({ username: result.command.username, temporaryPassword: result.temporaryPassword, commandId: result.command.id });
    },
    onError: (err) => setError(err.message),
  });
  const setRoleMutation = trpc.vessels.users.setRole.useMutation({
    onSuccess: () => invalidate(),
    onError: (err) => setError(err.message),
  });
  const setActiveMutation = trpc.vessels.users.setActive.useMutation({
    onSuccess: () => invalidate(),
    onError: (err) => setError(err.message),
  });

  const busyUsername =
    createMutation.variables?.username ??
    resetPasswordMutation.variables?.username ??
    setRoleMutation.variables?.username ??
    setActiveMutation.variables?.username ??
    null;
  const isBusy =
    createMutation.isPending || resetPasswordMutation.isPending || setRoleMutation.isPending || setActiveMutation.isPending;

  // The revealed password's own command, re-read from the polled list above,
  // so the panel below tracks it from Queued through to Applied rather than
  // stating a status once and going stale.
  const revealedCommand = revealed
    ? (commands as { id: string; appliedAt: string | null; fetchedAt: string | null }[]).find(
        (c) => c.id === revealed.commandId,
      )
    : undefined;
  const liveProgress = commandProgress(
    revealedCommand ?? { appliedAt: null, fetchedAt: null },
  );

  const handleAdd = () => {
    setError(null);
    createMutation.mutate(
      { vesselId, username: addUsername, role: addRole },
      {
        onSuccess: () => {
          setAddOpen(false);
          setAddUsername('');
          setAddRole(VESSEL_ROLES[0].value);
        },
      },
    );
  };

  const handleSetRole = () => {
    if (!roleTarget) return;
    setError(null);
    setRoleMutation.mutate(
      { vesselId, username: roleTarget.username, role: roleChoice },
      { onSuccess: () => setRoleTarget(null) },
    );
  };

  const handleDeactivate = () => {
    if (!deactivateTarget) return;
    setError(null);
    const username = deactivateTarget.username;
    setDeactivateTarget(null);
    setActiveMutation.mutate({ vesselId, username, active: false });
  };

  const handleReactivate = (username: string) => {
    setError(null);
    setActiveMutation.mutate({ vesselId, username, active: true });
  };

  const handleResetPassword = (username: string) => {
    setError(null);
    resetPasswordMutation.mutate({ vesselId, username });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto bg-background border-border text-foreground">
          {revealed ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-foreground">Temporary password — shown once</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  This password will not work until the vessel has pulled it. Watch for
                  &ldquo;Applied on vessel&rdquo; below before the crew member tries to sign in.
                </DialogDescription>
              </DialogHeader>

              {/*
                The lead used to be "Relay this to the crew member now", with the
                sync caveat trailing as a subordinate clause. Admins read the
                instruction, phoned it through, and the crew member hit "invalid
                password" because the vessel hadn't pulled the command yet — the
                delay is inherent (office can never write to a vessel's user
                table directly, see VesselUsersService), so the UI has to lead
                with it and then show the actual state rather than assert it.
              */}
              <div
                className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm ${
                  liveProgress.live
                    ? 'border-status-ok/25 bg-status-ok/10 text-status-ok'
                    : liveProgress.role === 'info'
                      ? 'border-status-info/25 bg-status-info/10 text-status-info'
                      : 'border-status-warn/25 bg-status-warn/10 text-status-warn'
                }`}
                role="status"
                aria-live="polite"
              >
                {liveProgress.live ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : liveProgress.role === 'info' ? (
                  <RadioTower className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">{liveProgress.label}</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    {liveProgress.live
                      ? 'The crew member can sign in with this password now.'
                      : 'Safe to relay it now, but tell them to wait for this to land before signing in.'}
                  </p>
                </div>
              </div>

              <div className="space-y-3 py-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wider">Username</Label>
                  <div className="font-mono text-sm text-foreground bg-muted rounded-md px-3 py-2 border border-border">
                    {revealed.username}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wider">Temporary password</Label>
                  {/* Relayed by satellite phone, so a mistyped character costs a
                      locked-out crew member and another round trip. */}
                  <CopyField value={revealed.temporaryPassword} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRevealed(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-foreground">Manage users — {vesselName}</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Remote user administration (architecture 9.3/12.4). Actions here queue a command the vessel
                  applies on its own next sync cycle — nothing changes on the vessel immediately.
                </DialogDescription>
              </DialogHeader>

              {error ? (
                <div className="text-sm text-status-critical bg-status-critical/10 border border-status-critical/30 rounded-md px-3 py-2">
                  {error}
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Crew accounts</h3>
                  <Button size="sm" onClick={() => setAddOpen(true)}>
                    <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                    Add user
                  </Button>
                </div>

                {roster.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No roster reported yet — this vessel hasn&apos;t synced since enrolling, or hasn&apos;t enrolled
                    yet.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {roster.map((u: any) => (
                      <div
                        key={u.username}
                        className="flex items-center justify-between gap-3 py-2 border-b border-border/40 last:border-b-0"
                      >
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            {u.username}{' '}
                            <span className="text-muted-foreground font-normal">· {vesselRoleLabel(u.role)}</span>
                          </div>
                          <div className={`text-xs ${u.active ? 'text-status-ok' : 'text-muted-foreground'}`}>
                            {u.active ? 'Active' : 'Deactivated'}
                            {u.canSubmit ? ' · can submit' : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-wrap justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isBusy && busyUsername === u.username}
                            onClick={() => handleResetPassword(u.username)}
                          >
                            <KeyRound className="w-3.5 h-3.5 mr-1" />
                            Reset password
                          </Button>
                          {u.role !== 'master' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isBusy && busyUsername === u.username}
                              onClick={() => {
                                setRoleChoice(u.role);
                                setRoleTarget({ username: u.username });
                              }}
                            >
                              <ShieldCheck className="w-3.5 h-3.5 mr-1" />
                              Change role
                            </Button>
                          ) : null}
                          {u.role !== 'master' ? (
                            u.active ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-status-critical hover:text-status-critical hover:bg-status-critical/10"
                                disabled={isBusy && busyUsername === u.username}
                                onClick={() => setDeactivateTarget({ username: u.username })}
                              >
                                <Ban className="w-3.5 h-3.5 mr-1" />
                                Deactivate
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isBusy && busyUsername === u.username}
                                onClick={() => handleReactivate(u.username)}
                              >
                                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                                Reactivate
                              </Button>
                            )
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3 pt-2 border-t border-border/60">
                <h3 className="text-sm font-semibold text-foreground pt-2">Pending &amp; recent actions</h3>
                {commands.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No remote user actions have been issued yet.</p>
                ) : (
                  <div className="space-y-2">
                    {commands.map((cmd: any) => (
                      <div key={cmd.id} className="flex items-start justify-between gap-3 text-sm">
                        <div>
                          <div className="text-foreground">
                            {commandLabel(cmd)} — {cmd.username}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {cmd.issuedBy} · {new Date(cmd.issuedAt).toLocaleString()}
                          </div>
                        </div>
                        <div
                          className={`text-xs whitespace-nowrap text-right ${
                            cmd.appliedAt
                              ? 'text-status-ok'
                              : cmd.fetchedAt
                                ? 'text-status-info'
                                : 'text-status-warn'
                          }`}
                        >
                          {commandStatus(cmd)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-[420px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Add crew account</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-username" className="text-muted-foreground">
                Username
              </Label>
              <Input
                id="add-username"
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                className="bg-card border-border text-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-role" className="text-muted-foreground">
                Role
              </Label>
              {/* Native <select>, not the shared Select component — Base
                  UI's floating-tree registration inside a Dialog's own
                  portal is exactly the combination that hung the Field
                  Policy tab this session; native controls sidestep it. */}
              <select
                id="add-role"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                className="w-full bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm"
              >
                {VESSEL_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Applies automatically on the vessel&apos;s next sync. A temporary password is generated and shown once
              — relay it to the crew member over the vessel&apos;s usual comms.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} className="bg-transparent border-border text-foreground hover:bg-muted">
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!addUsername.trim() || createMutation.isPending}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={roleTarget !== null} onOpenChange={(o) => !o && setRoleTarget(null)}>
        <DialogContent className="sm:max-w-[380px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {roleTarget ? `Change ${roleTarget.username}'s role?` : 'Change role?'}
            </DialogTitle>
          </DialogHeader>
          <select
            value={roleChoice}
            onChange={(e) => setRoleChoice(e.target.value)}
            className="w-full bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm"
          >
            {VESSEL_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleTarget(null)} className="bg-transparent border-border text-foreground hover:bg-muted">
              Cancel
            </Button>
            <Button onClick={handleSetRole} disabled={setRoleMutation.isPending}>
              Change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deactivateTarget !== null} onOpenChange={(o) => !o && setDeactivateTarget(null)}>
        <DialogContent className="sm:max-w-[420px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {deactivateTarget ? `Deactivate ${deactivateTarget.username}?` : 'Deactivate?'}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This account will no longer be able to log in on the vessel, once applied on its next sync. This can be
            undone with Reactivate at any time.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateTarget(null)} className="bg-transparent border-border text-foreground hover:bg-muted">
              Cancel
            </Button>
            <Button
              onClick={handleDeactivate}
              disabled={setActiveMutation.isPending}
              variant="destructive"
            >
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
