'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Shield, UserPlus, Search, MoreHorizontal, UserCheck, ShieldAlert, ShieldCheck, ArrowUpDown, Users as UsersIcon, UserX } from 'lucide-react';
import { Avatar, AvatarFallback } from '@ovl/ui/components/avatar';
import { CopyField } from '@ovl/ui/components/copy-field';
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@ovl/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuGroup } from '@ovl/ui/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ovl/ui/components/select';
import { Label } from '@ovl/ui/components/label';
import { useToastManager } from '@ovl/ui/components/toast';


export default function UsersPage() {
  // Master-only, matching the original app's own route guard. The nav item is
  // hidden for everyone else (AppShell), but a bookmarked URL has to be
  // refused here too rather than rendering a screen whose every action fails.
  const { data: me, isLoading: isMeLoading } = trpc.users.me.useQuery();
  const isMaster = (me?.role ?? '').toLowerCase() === 'master';

  const [searchQuery, setSearchQuery] = useState('');
  const toastManager = useToastManager();

  const utils = trpc.useUtils();
  const { data: users = [], isLoading } = trpc.users.list.useQuery();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newRole, setNewRole] = useState('Chief Engineer');
  const [generatedPassword, setGeneratedPassword] = useState('');

  const createUser = trpc.users.create.useMutation({
    onSuccess: (data) => {
      setGeneratedPassword(data.temporaryPassword);
      utils.users.list.invalidate();
    },
    onError: (err) => {
      toastManager.add({ title: 'Failed to create user', description: err.message, type: 'error' });
    }
  });

  const updateStatus = trpc.users.updateStatus.useMutation({
    onSuccess: () => utils.users.list.invalidate(),
  });

  const handleOnboard = () => {
    createUser.mutate({ username: newUsername, role: newRole, canSubmit: true });
  };

  const handleCloseCreate = (open: boolean) => {
    if (!open) {
      setGeneratedPassword('');
      setNewUsername('');
    }
    setIsCreateOpen(open);
  };

  const [selectedUserForRole, setSelectedUserForRole] = useState<any>(null);
  const [selectedUserForPassword, setSelectedUserForPassword] = useState<any>(null);
  const [editRoleValue, setEditRoleValue] = useState('');
  const [resetPasswordGenerated, setResetPasswordGenerated] = useState('');

  const updateRole = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      setSelectedUserForRole(null);
    },
    onError: (err) => toastManager.add({ title: 'Failed to update role', description: err.message, type: 'error' })
  });

  const adminResetPassword = trpc.users.adminResetPassword.useMutation({
    onSuccess: (data) => {
      setResetPasswordGenerated(data.temporaryPassword);
    },
    onError: (err) => toastManager.add({ title: 'Failed to reset password', description: err.message, type: 'error' })
  });

  const filteredUsers = users.filter((user: any) =>
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeCount = users.filter((u: any) => u.active).length;
  const inactiveCount = users.length - activeCount;
  const adminCount = users.filter((u: any) => u.role.includes('Master') || u.role.includes('Admin')).length;

  const stats = [
    { label: 'Total Crew', value: users.length.toString(), icon: UsersIcon, color: 'text-foreground' },
    { label: 'Active', value: activeCount.toString(), icon: UserCheck, color: 'text-status-ok' },
    { label: 'Inactive', value: inactiveCount.toString(), icon: UserX, color: 'text-muted-foreground' },
    { label: 'Admin / Master', value: adminCount.toString(), icon: ShieldCheck, color: 'text-status-warn' },
  ];

  if (isMeLoading) {
    return <p className="text-sm text-muted-foreground">Checking permissions&hellip;</p>;
  }

  if (!isMaster) {
    return (
      <div className="max-w-md mx-auto text-center space-y-3 py-16">
        <div className="mx-auto w-11 h-11 rounded-full bg-muted border border-border flex items-center justify-center">
          <ShieldAlert className="w-5 h-5 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Master access only</h1>
        <p className="text-sm text-muted-foreground">
          Crew accounts are managed by the vessel&apos;s Master, or from the shore office.
        </p>
      </div>
    );
  }
  return (
    // Fixed to the viewport, same as Dashboard — a crew roster shouldn't
    // require scrolling the whole page to find the onboarding button;
    // only the directory table scrolls internally.
    <div className="flex flex-col gap-4 pb-4 xl:pb-0 xl:h-[calc(100vh_-_88px)] xl:overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Crew & Access Management</h1>
          <p className="text-muted-foreground mt-1 text-sm">Control local node access and crew permissions.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by username or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-card border-border focus-visible:ring-ring text-foreground rounded-sm h-10 text-sm w-full transition-all"
            />
          </div>
          <Dialog open={isCreateOpen} onOpenChange={handleCloseCreate}>
            <DialogTrigger className="inline-flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-10 px-4 py-2 text-sm font-medium shrink-0 transition-all">
              <UserPlus className="w-4 h-4 mr-2" />
              Onboard Crew
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
              <DialogHeader>
                <DialogTitle>Onboard New Crew Member</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Create a local offline account for the edge node.
                </DialogDescription>
              </DialogHeader>

              {!generatedPassword ? (
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="username" className="text-foreground">Username</Label>
                    <Input id="username" value={newUsername} onChange={e => setNewUsername(e.target.value)} className="bg-card border-border focus-visible:ring-ring" placeholder="e.g. j.doe" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="role" className="text-foreground">Role</Label>
                    <Select value={newRole} onValueChange={(val) => setNewRole(val || 'Able Seaman')}>
                      <SelectTrigger className="bg-card border-border focus-visible:ring-ring">
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent className="bg-card border-border text-foreground">
                        <SelectItem value="Chief Engineer">Chief Engineer</SelectItem>
                        <SelectItem value="Second Officer">Second Officer</SelectItem>
                        <SelectItem value="Able Seaman">Able Seaman</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : (
                <div className="py-6 space-y-4 text-center">
                  <div className="bg-status-ok/10 text-status-ok p-3 rounded-sm border border-status-ok/25 text-sm">
                    User successfully created!
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Temporary Password (Reveal Once):</p>
                    <CopyField value={generatedPassword} />
                  </div>
                  <p className="text-xs text-status-warn/90 mt-2">
                    Make sure to copy this now. You won't be able to see it again.
                  </p>
                </div>
              )}

              <DialogFooter>
                {!generatedPassword ? (
                  <Button onClick={handleOnboard} disabled={!newUsername || createUser.isPending} className="bg-primary text-primary-foreground hover:bg-primary/90">
                    {createUser.isPending ? 'Creating...' : 'Create Account'}
                  </Button>
                ) : (
                  <Button onClick={() => handleCloseCreate(false)} className="bg-primary text-primary-foreground hover:bg-primary/90">
                    Done
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stat strip — mirrors Dashboard's KPI row so both screens read
          as one consistent instrument-panel layout. Always visible,
          never part of the scrolling directory below. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
        {stats.map((stat) => (
          <Card key={stat.label} className="bg-card border-border rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <stat.icon className={`w-4 h-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="flex flex-col bg-card border-border overflow-hidden rounded-sm xl:flex-1 xl:min-h-0">
        <CardHeader className="border-b border-border px-4 py-3 shrink-0">
          <CardDescription className="text-xs text-muted-foreground">Personnel authorized for edge-node access.</CardDescription>
        </CardHeader>
        <CardContent className="p-0 flex flex-col xl:flex-1 xl:min-h-0">
          <div className="overflow-x-auto xl:overflow-y-auto xl:flex-1 xl:min-h-0">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-card border-b border-border sticky top-0 z-10">
                <tr>
                  <th scope="col" className="px-6 py-3 font-semibold"><div className="flex items-center gap-2">User <ArrowUpDown className="w-3 h-3" /></div></th>
                  <th scope="col" className="hidden md:table-cell px-6 py-3 font-semibold">Security Role</th>
                  <th scope="col" className="px-6 py-3 font-semibold">Account Status</th>
                  <th scope="col" className="px-6 py-3 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground bg-card">
                      Loading crew directory...
                    </td>
                  </tr>
                ) : filteredUsers.length > 0 ? (
                  filteredUsers.map((user: any) => (
                    <tr key={user.id} className="border-b border-border hover:bg-muted transition-all group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 bg-muted border border-border">
                            <AvatarFallback className="text-foreground bg-transparent text-xs font-semibold">{user.username.substring(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-foreground group-hover:text-foreground transition-colors">{user.username}</div>
                            <div className="text-xs text-muted-foreground">Edge Account</div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden md:table-cell px-6 py-4">
                        <div className="flex items-center gap-2">
                          {user.role.includes('Master') || user.role.includes('Admin') ? <ShieldCheck className="w-4 h-4 text-status-warn/80" /> : <Shield className="w-4 h-4 text-muted-foreground" />}
                          <span className="text-foreground font-medium">{user.role}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm text-xs font-semibold tracking-wide uppercase border cursor-pointer hover:opacity-80 transition-opacity ${user.active ? 'bg-status-ok/10 text-status-ok border-status-ok/25' : 'bg-muted text-muted-foreground border-border'}`}
                          onClick={() => updateStatus.mutate({ id: user.id, active: !user.active })}
                        >
                          {user.active ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                          {user.active ? 'Active' : 'Inactive'}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={`Manage ${user.username}`}
                            className="inline-flex items-center justify-center rounded-sm text-sm font-medium transition-colors hover:bg-surface-hover hover:text-foreground text-muted-foreground"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="bg-background border-border text-foreground">
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem
                                className="focus:bg-card focus:text-foreground cursor-pointer"
                                onClick={() => { setSelectedUserForRole(user); setEditRoleValue(user.role); }}
                              >
                                Edit Profile / Role
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="focus:bg-card focus:text-foreground cursor-pointer"
                                onClick={() => { setSelectedUserForPassword(user); setResetPasswordGenerated(''); }}
                              >
                                Reset Password
                              </DropdownMenuItem>
                              <DropdownMenuSeparator className="bg-muted" />
                              <DropdownMenuItem
                                className="focus:bg-card focus:text-foreground cursor-pointer text-status-critical focus:text-status-critical"
                                onClick={() => updateStatus.mutate({ id: user.id, active: !user.active })}
                              >
                                {user.active ? 'Deactivate User' : 'Reactivate User'}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground bg-card">
                      No users found matching &quot;{searchQuery}&quot;.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Edit Role Dialog */}
      <Dialog open={!!selectedUserForRole} onOpenChange={(open) => !open && setSelectedUserForRole(null)}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Edit User Profile</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Change the security role for {selectedUserForRole?.username}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-role" className="text-foreground">Security Role</Label>
              <Select value={editRoleValue} onValueChange={(val) => val && setEditRoleValue(val)}>
                <SelectTrigger className="bg-card border-border focus-visible:ring-ring">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="Master" className="focus:bg-muted focus:text-foreground cursor-pointer">Master</SelectItem>
                  <SelectItem value="Chief Engineer" className="focus:bg-muted focus:text-foreground cursor-pointer">Chief Engineer</SelectItem>
                  <SelectItem value="Second Officer" className="focus:bg-muted focus:text-foreground cursor-pointer">Second Officer</SelectItem>
                  <SelectItem value="Able Seaman" className="focus:bg-muted focus:text-foreground cursor-pointer">Able Seaman</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedUserForRole(null)} className="border-border bg-background text-foreground hover:bg-card hover:text-foreground">Cancel</Button>
            <Button
              onClick={() => updateRole.mutate({ id: selectedUserForRole.id, role: editRoleValue })}
              disabled={updateRole.isPending}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {updateRole.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!selectedUserForPassword} onOpenChange={(open) => {
        if (!open) {
          setSelectedUserForPassword(null);
          setResetPasswordGenerated('');
        }
      }}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Generate a new temporary password for {selectedUserForPassword?.username}.
            </DialogDescription>
          </DialogHeader>

          {!resetPasswordGenerated ? (
            <div className="py-4">
              <p className="text-sm text-foreground mb-4">
                This will immediately invalidate their current password. They will be required to change this temporary password upon their next login.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSelectedUserForPassword(null)} className="border-border bg-background text-foreground hover:bg-card hover:text-foreground">Cancel</Button>
                <Button
                  onClick={() => adminResetPassword.mutate({ id: selectedUserForPassword.id })}
                  disabled={adminResetPassword.isPending}
                  variant="destructive"
                >
                  {adminResetPassword.isPending ? 'Resetting...' : 'Confirm Reset'}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="py-4">
              <div className="mt-2 space-y-2">
                <p className="text-muted-foreground font-medium uppercase tracking-wider text-xs">New Temporary Password</p>
                <CopyField value={resetPasswordGenerated} />
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Please provide this password to the crew member. It will only be shown once.
              </p>
              <DialogFooter className="mt-6">
                <Button onClick={() => setSelectedUserForPassword(null)} className="bg-primary hover:bg-primary/90 text-primary-foreground">Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
