'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, UserPlus, Search, MoreHorizontal, UserCheck, ShieldAlert, ArrowUpDown, Filter, UserX } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuGroup } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useToastManager } from '@/components/ui/toast';


export default function UsersPage() {
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

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border/60 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Crew & Access Management</h1>
          <p className="text-muted-foreground mt-1.5 text-sm font-medium">Control local node access and crew permissions.</p>
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
          <Button variant="outline" className="border-border bg-background text-foreground hover:text-foreground hover:bg-card rounded-md h-9 shadow-sm shrink-0">
            <Filter className="w-4 h-4 mr-2" />
            Filter
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={handleCloseCreate}>
            <DialogTrigger className="inline-flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 px-4 py-2 text-sm font-semibold shadow-sm shrink-0 transition-all">
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

      <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Local Directory</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">Personnel authorized for edge-node access.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-background/40 border-b border-border/60">
                <tr>
                  <th scope="col" className="px-6 py-3 font-semibold flex items-center gap-2">User <ArrowUpDown className="w-3 h-3" /></th>
                  <th scope="col" className="px-6 py-3 font-semibold">Security Role</th>
                  <th scope="col" className="px-6 py-3 font-semibold">Account Status</th>
                  <th scope="col" className="px-6 py-3 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground bg-background/20">
                      Loading crew directory...
                    </td>
                  </tr>
                ) : filteredUsers.length > 0 ? (
                  filteredUsers.map((user: any) => (
                    <tr key={user.id} className="border-b border-border/40 hover:bg-muted/20 transition-all group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 bg-muted border border-border shadow-sm">
                            <AvatarFallback className="text-foreground bg-transparent text-xs font-semibold">{user.username.substring(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-foreground group-hover:text-foreground transition-colors">{user.username}</div>
                            <div className="text-xs text-muted-foreground">Edge Account</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {user.role.includes('Master') || user.role.includes('Admin') ? <ShieldAlert className="w-4 h-4 text-amber-500/80" /> : <Shield className="w-4 h-4 text-muted-foreground" />}
                          <span className="text-foreground font-medium">{user.role}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div 
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide uppercase border cursor-pointer hover:opacity-80 transition-opacity ${user.active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-muted/50 text-muted-foreground border-border/50'}`}
                          onClick={() => updateStatus.mutate({ id: user.id, active: !user.active })}
                        >
                          {user.active ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                          {user.active ? 'Active' : 'Inactive'}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-muted hover:text-foreground h-8 w-8 text-muted-foreground">
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
                                className="focus:bg-card focus:text-foreground cursor-pointer text-red-400 focus:text-red-300"
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
              className="bg-indigo-600 hover:bg-indigo-500 text-white"
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
                  className="bg-red-600 hover:bg-red-500 text-white"
                >
                  {adminResetPassword.isPending ? 'Resetting...' : 'Confirm Reset'}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="py-4">
              <div className="bg-card border border-border rounded-md p-4 mt-2">
                <p className="text-sm text-muted-foreground mb-1 font-medium uppercase tracking-wider text-[10px]">New Temporary Password</p>
                <div className="flex items-center justify-between">
                  <code className="text-xl font-mono text-emerald-400">{resetPasswordGenerated}</code>
                </div>
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
