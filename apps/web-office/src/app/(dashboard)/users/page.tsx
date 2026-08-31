'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Shield, UserPlus, Search, UserCheck, ShieldAlert, ShieldCheck, Edit, Trash2, Check } from 'lucide-react';
import { Avatar, AvatarFallback } from '@ovl/ui/components/avatar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ovl/ui/components/dialog';
import { Label } from '@ovl/ui/components/label';
import { Switch } from '@ovl/ui/components/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ovl/ui/components/dropdown-menu';

import { CopyField } from '@ovl/ui/components/copy-field';
import { OneTimeSecret } from '@ovl/ui/components/one-time-secret';
import { ConfirmDialog } from '@ovl/ui/components/confirm-dialog';
import { trpc } from '@/lib/trpc';

// Mirrors apps/api-office/src/users/dto/create-user.dto.ts's UserRole
// enum exactly — a user can hold more than one of these at once
// (roles is a jsonb array on the users table), which is why this is a
// checklist rather than a single-select.
const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'configManager', label: 'Config Manager' },
  { value: 'commercialEditor', label: 'Commercial Editor' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'viewer', label: 'Viewer' },
];

export default function UsersPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; username: string } | null>(null);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newRoles, setNewRoles] = useState<string[]>(['viewer']);
  const [generatedPassword, setGeneratedPassword] = useState('');

  const [resetTarget, setResetTarget] = useState<{ id: string; username: string } | null>(null);
  const [resetPasswordGenerated, setResetPasswordGenerated] = useState('');

  const utils = trpc.useUtils();
  const { data: users = [], isLoading } = trpc.users.list.useQuery();

  // Platform-wide mode — every tenant's users at once, for a super admin who
  // has selected none. Read from the rows themselves, so the extra column and
  // the data cannot disagree about which mode this is.
  const acrossTenants = users.some((u: any) => u.tenantSlug);

  const updateMutation = trpc.users.update.useMutation({
    meta: { errorTitle: "Couldn't update that user" },
    onSuccess: () => {
      utils.users.list.invalidate();
      setIsDialogOpen(false);
    }
  });

  const deleteMutation = trpc.users.delete.useMutation({
    meta: { errorTitle: "Couldn't delete that user" },
    onSuccess: () => {
      utils.users.list.invalidate();
      setDeleteTarget(null);
    }
  });

  const createMutation = trpc.users.create.useMutation({
    // Rendered inline in the dialog below, so the global mutation toast
    // would just say the same thing twice.
    meta: { silentError: true },
    onSuccess: (data) => {
      setGeneratedPassword(data.temporaryPassword);
      utils.users.list.invalidate();
    },
  });

  const resetPasswordMutation = trpc.users.resetPassword.useMutation({
    // Rendered inline in the dialog below, so the global mutation toast
    // would just say the same thing twice.
    meta: { silentError: true },
    onSuccess: (data) => {
      setResetPasswordGenerated(data.temporaryPassword);
    },
  });

  const toggleNewRole = (value: string) => {
    setNewRoles((prev) => (prev.includes(value) ? prev.filter((r) => r !== value) : [...prev, value]));
  };

  const handleCloseCreate = (open: boolean) => {
    if (!open) {
      setGeneratedPassword('');
      setNewUsername('');
      setNewRoles(['viewer']);
    }
    setIsCreateOpen(open);
  };

  const handleOnboard = () => {
    createMutation.mutate({ username: newUsername, roles: newRoles as any });
  };

  const filteredUsers = users.filter((user: any) => 
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.roles && user.roles.join(', ').toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const openEditDialog = (user: any) => {
    setEditingUser(user);
    setRoles(user.roles ?? []);
    setActive(user.active);
    setIsDialogOpen(true);
  };

  const toggleRole = (value: string) => {
    setRoles((prev) => (prev.includes(value) ? prev.filter((r) => r !== value) : [...prev, value]));
  };

  const handleSave = () => {
    if (editingUser) {
      updateMutation.mutate({
        id: editingUser.id,
        roles,
        active
      });
    }
  };

  const handleDelete = (id: string, username: string) => {
    setDeleteTarget({ id, username });
  };

  const confirmDelete = () => {
    if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
  };

  return (
    // Fixed to the viewport, not the page — same fix as Global Reports
    // Ledger: only the directory table scrolls internally.
    <div className="h-[calc(100vh-136px)] lg:h-[calc(100vh-168px)] flex flex-col space-y-8 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">User Access Management</h1>
          <p className="text-muted-foreground mt-1.5 text-sm font-medium">Control roles, permissions, and security policies across the fleet.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-72">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by username or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-sm w-full"
            />
          </div>
          {/* A user belongs to one tenant, so there is no tenant to create
              them in while every tenant is on screen. Disabled with the
              reason, rather than hidden as if it were forbidden. */}
          <Button
            onClick={() => setIsCreateOpen(true)}
            disabled={acrossTenants}
            title={acrossTenants ? 'Select a tenant before onboarding a user into it' : undefined}
            className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all"
          >
            <UserPlus className="w-4 h-4 mr-2" />
            Onboard User
          </Button>
        </div>
      </div>

      <Card className="flex-1 flex flex-col bg-card border-border shadow-sm min-h-0 overflow-hidden rounded-md">
        <CardHeader className="border-b border-border pb-4 bg-card shrink-0">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Active Directory</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">All registered personnel and service accounts.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
          <div className="h-full overflow-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-card border-b border-border sticky top-0 z-10">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">User</th>
                  <th scope="col" className="hidden md:table-cell px-4 py-2 font-semibold">Security Role</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Account Status</th>
                  {acrossTenants && (
                    <th scope="col" className="px-4 py-2 font-semibold">Tenant</th>
                  )}
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={acrossTenants ? 5 : 4} className="px-6 py-12 text-center text-muted-foreground bg-card">
                      Loading users...
                    </td>
                  </tr>
                ) : filteredUsers.length > 0 ? (
                  filteredUsers.map((user: any) => {
                    const displayRole = user.roles && user.roles.length > 0
                      ? user.roles.map((r: string) => ROLE_OPTIONS.find((opt) => opt.value === r)?.label ?? r).join(', ')
                      : 'None';
                    const isAdmin = user.roles && user.roles.includes('admin');
                    
                    return (
                    <tr key={user.id} className="border-b border-border hover:bg-muted transition-all group">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 bg-muted border border-border shadow-sm">
                            <AvatarFallback className="text-foreground bg-transparent text-xs font-semibold">{user.username.substring(0,2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-foreground group-hover:text-foreground transition-colors">{user.username}</div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden md:table-cell px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {/* ShieldCheck, not ShieldAlert: this marks a privileged account, which is
                              a normal state. A shield-with-exclamation is the app's vocabulary for
                              "something needs attention" (see the login and force-password-change
                              screens) and made every admin row read as a fault. */}
                          {isAdmin ? <ShieldCheck className="w-4 h-4 text-status-warn/80" /> : <Shield className="w-4 h-4 text-muted-foreground" />}
                          <span className="text-foreground font-medium capitalize">{displayRole}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold tracking-wide uppercase border ${user.active ? 'bg-status-ok/10 text-status-ok border-status-ok/25' : 'bg-muted text-muted-foreground border-border'}`}>
                          {user.active && <UserCheck className="w-3 h-3" />}
                          {user.active ? 'Active' : 'Inactive'}
                        </div>
                      </td>
                      {acrossTenants && (
                        <td className="px-4 py-2.5 text-foreground text-xs font-medium">
                          {user.tenantName}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon" aria-label={`Manage ${user.username}`} className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors" />
                            }
                          >
                            <Edit className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 bg-background border-border">
                            <DropdownMenuItem onClick={() => openEditDialog(user)} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-foreground">
                              <Edit className="mr-2 h-4 w-4" />
                              <span>Edit User</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setResetTarget({ id: user.id, username: user.username }); setResetPasswordGenerated(''); }} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-foreground">
                              <ShieldAlert className="mr-2 h-4 w-4" />
                              <span>Reset Password</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(user.id, user.username)} className="text-status-critical hover:bg-status-critical/10 cursor-pointer focus:bg-status-critical/10 focus:text-status-critical">
                              <Trash2 className="mr-2 h-4 w-4" />
                              <span>Delete User</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  )})
                ) : (
                  <tr>
                    <td colSpan={acrossTenants ? 5 : 4} className="px-6 py-12 text-center text-muted-foreground bg-card">
                      {users.length === 0 ? 'No users yet.' : 'No users match that search.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Edit User Roles</DialogTitle>
          </DialogHeader>
          <div className="grid gap-5 py-4">
            <div className="space-y-2">
              <Label className="text-foreground">Roles</Label>
              <p className="text-xs text-muted-foreground">A user can hold more than one role at a time.</p>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {ROLE_OPTIONS.map((opt) => {
                  const checked = roles.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleRole(opt.value)}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                        checked
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked ? 'border-primary bg-primary' : 'border-border'
                        }`}
                      >
                        {checked && <Check className="h-3 w-3 text-primary-foreground" />}
                      </span>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2.5">
              <div>
                <Label className="text-foreground">Account Active</Label>
                <p className="text-xs text-muted-foreground">Inactive users can&apos;t sign in.</p>
              </div>
              <Switch checked={active} onCheckedChange={setActive} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="bg-transparent border-border text-foreground hover:bg-muted hover:text-foreground">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Delete user?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove <span className="font-medium text-foreground">{deleteTarget?.username}</span>&apos;s
            access. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} className="bg-transparent border-border text-foreground hover:bg-muted hover:text-foreground">
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
              variant="destructive"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateOpen} onOpenChange={handleCloseCreate}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Onboard New User</DialogTitle>
          </DialogHeader>

          {!generatedPassword ? (
            <div className="grid gap-5 py-4">
              <div className="space-y-2">
                <Label htmlFor="new-username" className="text-foreground">Email</Label>
                <Input
                  id="new-username"
                  type="email"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="bg-card border-border text-foreground"
                  placeholder="e.g. j.doe@company.com"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-foreground">Roles</Label>
                <div className="grid grid-cols-2 gap-2">
                  {ROLE_OPTIONS.map((opt) => {
                    const checked = newRoles.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggleNewRole(opt.value)}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                          checked
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border bg-card text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            checked ? 'border-primary bg-primary' : 'border-border'
                          }`}
                        >
                          {checked && <Check className="h-3 w-3 text-primary-foreground" />}
                        </span>
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {createMutation.error && (
                <p className="text-sm text-status-critical">{createMutation.error.message}</p>
              )}
            </div>
          ) : (
            <div className="py-6 space-y-4 text-center">
              <div className="bg-status-ok/10 text-status-ok p-3 rounded-md border border-status-ok/25 text-sm">
                User successfully created!
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Temporary Password (Reveal Once):</p>
                <CopyField value={generatedPassword} />
              </div>
              <p className="text-xs text-status-warn/90 mt-2">
                Make sure to copy this now. You won&apos;t be able to see it again.
              </p>
            </div>
          )}

          <DialogFooter>
            {!generatedPassword ? (
              <Button
                onClick={handleOnboard}
                disabled={!newUsername || newRoles.length === 0 || createMutation.isPending}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {createMutation.isPending ? 'Creating...' : 'Create Account'}
              </Button>
            ) : (
              <Button onClick={() => handleCloseCreate(false)} className="bg-primary text-primary-foreground hover:bg-primary/90">
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Both halves of this dialog — the confirmation and the one-time
          password — now come from shared components, so the office and vessel
          apps cannot drift apart again and the footer is placed correctly by
          construction. */}
      <ConfirmDialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null);
            setResetPasswordGenerated('');
            resetPasswordMutation.reset();
          }
        }}
        title="Reset Password"
        description={
          <>
            This will generate a new temporary password for{' '}
            <span className="font-medium text-foreground">{resetTarget?.username}</span> and
            invalidate their current one. They will be required to change it on next login.
          </>
        }
        error={resetPasswordMutation.error?.message ?? null}
        confirmLabel="Confirm Reset"
        pendingLabel="Resetting..."
        confirmVariant="destructive"
        pending={resetPasswordMutation.isPending}
        onConfirm={() => resetTarget && resetPasswordMutation.mutate({ id: resetTarget.id })}
        result={
          resetPasswordGenerated ? (
            <OneTimeSecret
              value={resetPasswordGenerated}
              label="New temporary password"
              warning="Provide this to the user. It is only shown once."
            />
          ) : null
        }
      />
    </div>
  );
}
