'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, UserPlus, Search, UserCheck, ShieldAlert, ArrowUpDown, Filter, Edit, Trash2, Check } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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

  const updateMutation = trpc.users.update.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      setIsDialogOpen(false);
    }
  });

  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      setDeleteTarget(null);
    }
  });

  const createMutation = trpc.users.create.useMutation({
    onSuccess: (data) => {
      setGeneratedPassword(data.temporaryPassword);
      utils.users.list.invalidate();
    },
  });

  const resetPasswordMutation = trpc.users.resetPassword.useMutation({
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
    <div className="h-[calc(100vh-136px)] lg:h-[calc(100vh-168px)] flex flex-col space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border/60 pb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">User Access Management</h1>
          <p className="text-muted-foreground mt-1.5 text-sm font-medium">Control roles, permissions, and security policies across the fleet.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-72 shadow-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by username or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-background/80 border-border/80 focus-visible:ring-ring text-foreground rounded-md h-9 text-sm w-full transition-all"
            />
          </div>
          <Button onClick={() => setIsCreateOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
            <UserPlus className="w-4 h-4 mr-2" />
            Onboard User
          </Button>
        </div>
      </div>

      <Card className="flex-1 flex flex-col bg-card/40 border-border/60 shadow-xl min-h-0 overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-border/60 pb-4 bg-card/20 shrink-0">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Active Directory</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">All registered personnel and service accounts.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
          <div className="h-full overflow-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-background/90 backdrop-blur-sm border-b border-border/60 sticky top-0 z-10">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold flex items-center gap-2">User <ArrowUpDown className="w-3 h-3" /></th>
                  <th scope="col" className="px-4 py-2 font-semibold">Security Role</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Account Status</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground bg-background/20">
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
                    <tr key={user.id} className="border-b border-border/40 hover:bg-muted/20 transition-all group">
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
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {isAdmin ? <ShieldAlert className="w-4 h-4 text-amber-500/80" /> : <Shield className="w-4 h-4 text-muted-foreground" />}
                          <span className="text-foreground font-medium capitalize">{displayRole}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold tracking-wide uppercase border ${user.active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-muted/50 text-muted-foreground border-border/50'}`}>
                          {user.active && <UserCheck className="w-3 h-3" />}
                          {user.active ? 'Active' : 'Inactive'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors" />
                            }
                          >
                            <Edit className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 bg-background border-border">
                            <DropdownMenuItem onClick={() => openEditDialog(user)} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-white">
                              <Edit className="mr-2 h-4 w-4" />
                              <span>Edit User</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setResetTarget({ id: user.id, username: user.username }); setResetPasswordGenerated(''); }} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-white">
                              <ShieldAlert className="mr-2 h-4 w-4" />
                              <span>Reset Password</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(user.id, user.username)} className="text-red-400 hover:bg-red-500/10 cursor-pointer focus:bg-red-500/10 focus:text-red-400">
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
                    <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground bg-background/20">
                      No users found matching &quot;{searchQuery}&quot;.
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
                          : 'border-border bg-card text-muted-foreground hover:bg-muted/50'
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
              className="bg-red-600 hover:bg-red-700 text-white"
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
                            : 'border-border bg-card text-muted-foreground hover:bg-muted/50'
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
                <p className="text-sm text-red-400">{createMutation.error.message}</p>
              )}
            </div>
          ) : (
            <div className="py-6 space-y-4 text-center">
              <div className="bg-emerald-500/10 text-emerald-400 p-3 rounded-md border border-emerald-500/20 text-sm">
                User successfully created!
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Temporary Password (Reveal Once):</p>
                <div className="text-xl font-mono tracking-wider bg-card p-4 rounded border border-border select-all">
                  {generatedPassword}
                </div>
              </div>
              <p className="text-xs text-amber-500/90 mt-2">
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

      <Dialog open={!!resetTarget} onOpenChange={(open) => { if (!open) { setResetTarget(null); setResetPasswordGenerated(''); } }}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Reset Password</DialogTitle>
          </DialogHeader>

          {!resetPasswordGenerated ? (
            <div className="py-4">
              <p className="text-sm text-foreground mb-4">
                This will generate a new temporary password for <span className="font-medium">{resetTarget?.username}</span> and
                invalidate their current one. They will be required to change it on next login.
              </p>
              {resetPasswordMutation.error && (
                <p className="text-sm text-red-400 mb-4">{resetPasswordMutation.error.message}</p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setResetTarget(null)} className="bg-transparent border-border text-foreground hover:bg-muted hover:text-foreground">
                  Cancel
                </Button>
                <Button
                  onClick={() => resetTarget && resetPasswordMutation.mutate({ id: resetTarget.id })}
                  disabled={resetPasswordMutation.isPending}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  {resetPasswordMutation.isPending ? 'Resetting...' : 'Confirm Reset'}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="py-4">
              <div className="bg-card border border-border rounded-md p-4 mt-2">
                <p className="text-sm text-muted-foreground mb-1 font-medium uppercase tracking-wider text-xs">New Temporary Password</p>
                <div className="flex items-center justify-between">
                  <code className="text-xl font-mono text-emerald-400">{resetPasswordGenerated}</code>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Please provide this password to the user. It will only be shown once.
              </p>
              <DialogFooter className="mt-6">
                <Button onClick={() => setResetTarget(null)} className="bg-primary hover:bg-primary/90 text-primary-foreground">Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
