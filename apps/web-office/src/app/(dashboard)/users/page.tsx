'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, UserPlus, Search, UserCheck, ShieldAlert, ArrowUpDown, Filter, Edit, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { trpc } from '@/lib/trpc';

export default function UsersPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [roles, setRoles] = useState('');
  const [active, setActive] = useState(true);

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
    }
  });

  const filteredUsers = users.filter((user: any) => 
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.roles && user.roles.join(', ').toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const openEditDialog = (user: any) => {
    setEditingUser(user);
    setRoles(user.roles ? user.roles.join(', ') : '');
    setActive(user.active);
    setIsDialogOpen(true);
  };

  const handleSave = () => {
    if (editingUser) {
      updateMutation.mutate({ 
        id: editingUser.id, 
        roles: roles.split(',').map(r => r.trim()).filter(Boolean),
        active 
      });
    }
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this user?')) {
      deleteMutation.mutate({ id });
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800/60 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">User Access Management</h1>
          <p className="text-zinc-400 mt-1.5 text-sm font-medium">Control roles, permissions, and security policies across the fleet.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-72 shadow-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
            <Input 
              placeholder="Search by username or role..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 rounded-md h-9 text-sm w-full transition-all"
            />
          </div>
        </div>
      </div>

      <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
          <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Active Directory</CardTitle>
          <CardDescription className="text-xs text-zinc-500">All registered personnel and service accounts.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400">
              <thead className="text-xs text-zinc-500 uppercase tracking-wider bg-zinc-950/40 border-b border-zinc-800/60">
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
                    <td colSpan={4} className="px-6 py-12 text-center text-zinc-500 bg-zinc-950/20">
                      Loading users...
                    </td>
                  </tr>
                ) : filteredUsers.length > 0 ? (
                  filteredUsers.map((user: any) => {
                    const displayRole = user.roles && user.roles.length > 0 ? user.roles.join(', ') : 'None';
                    const isAdmin = user.roles && user.roles.includes('Admin');
                    
                    return (
                    <tr key={user.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-all group">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 bg-zinc-800 border border-zinc-700 shadow-sm">
                            <AvatarFallback className="text-zinc-300 bg-transparent text-xs font-semibold">{user.username.substring(0,2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-zinc-200 group-hover:text-white transition-colors">{user.username}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {isAdmin ? <ShieldAlert className="w-4 h-4 text-amber-500/80" /> : <Shield className="w-4 h-4 text-zinc-500" />}
                          <span className="text-zinc-300 font-medium capitalize">{displayRole}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide uppercase border ${user.active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50'}`}>
                          {user.active && <UserCheck className="w-3 h-3" />}
                          {user.active ? 'Active' : 'Inactive'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors" />
                            }
                          >
                            <Edit className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 bg-zinc-950 border-zinc-800">
                            <DropdownMenuItem onClick={() => openEditDialog(user)} className="hover:bg-zinc-800 cursor-pointer text-zinc-300 focus:bg-zinc-800 focus:text-white">
                              <Edit className="mr-2 h-4 w-4" />
                              <span>Edit User</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(user.id)} className="text-red-400 hover:bg-red-500/10 cursor-pointer focus:bg-red-500/10 focus:text-red-400">
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
                    <td colSpan={4} className="px-6 py-12 text-center text-zinc-500 bg-zinc-950/20">
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
        <DialogContent className="sm:max-w-[425px] bg-zinc-950 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Edit User Roles</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="roles" className="text-right text-zinc-400">
                Roles
              </Label>
              <Input
                id="roles"
                value={roles}
                onChange={(e) => setRoles(e.target.value)}
                className="col-span-3 bg-zinc-900 border-zinc-800 text-zinc-100"
                placeholder="Admin, viewer"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right text-zinc-400">
                Active
              </Label>
              <input 
                type="checkbox" 
                checked={active} 
                onChange={(e) => setActive(e.target.checked)} 
                className="col-span-3 w-4 h-4 accent-indigo-500"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="bg-transparent border-zinc-800 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
