'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, UserPlus, Search, MoreHorizontal, UserCheck, ShieldAlert, ArrowUpDown, Filter, UserX } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

const MOCK_USERS = [
  { id: 1, name: 'Captain John', email: 'john@ovl.com', role: 'Vessel Captain', status: 'Active', avatar: 'CJ' },
  { id: 2, name: 'Marcus Johnson', email: 'marcus.j@ovl.com', role: 'Chief Engineer', status: 'Active', avatar: 'MJ' },
  { id: 3, name: 'Vessel Admin', email: 'admin@ovl.com', role: 'System Admin', status: 'Active', avatar: 'VA' },
];

export default function UsersPage() {
  const [searchQuery, setSearchQuery] = useState('');
  
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
      alert('Failed to create user: ' + err.message);
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

  const filteredUsers = users.filter((user: any) => 
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) || 
    user.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800/60 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Crew & Access Management</h1>
          <p className="text-zinc-400 mt-1.5 text-sm font-medium">Control local node access and crew permissions.</p>
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
          <Button variant="outline" className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:text-white hover:bg-zinc-900 rounded-md h-9 shadow-sm shrink-0">
            <Filter className="w-4 h-4 mr-2" />
            Filter
          </Button>
          <Dialog open={isCreateOpen} onOpenChange={handleCloseCreate}>
            <DialogTrigger asChild>
              <Button className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
                <UserPlus className="w-4 h-4 mr-2" />
                Onboard Crew
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-zinc-950 border-zinc-800 text-zinc-100">
              <DialogHeader>
                <DialogTitle>Onboard New Crew Member</DialogTitle>
                <DialogDescription className="text-zinc-400">
                  Create a local offline account for the edge node.
                </DialogDescription>
              </DialogHeader>
              
              {!generatedPassword ? (
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="username" className="text-zinc-300">Username</Label>
                    <Input id="username" value={newUsername} onChange={e => setNewUsername(e.target.value)} className="bg-zinc-900 border-zinc-800 focus-visible:ring-zinc-700" placeholder="e.g. j.doe" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="role" className="text-zinc-300">Role</Label>
                    <Select value={newRole} onValueChange={setNewRole}>
                      <SelectTrigger className="bg-zinc-900 border-zinc-800 focus-visible:ring-zinc-700">
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
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
                    <p className="text-sm text-zinc-400">Temporary Password (Reveal Once):</p>
                    <div className="text-xl font-mono tracking-wider bg-zinc-900 p-4 rounded border border-zinc-800 select-all">
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
                  <Button onClick={handleOnboard} disabled={!newUsername || createUser.isPending} className="bg-zinc-100 text-zinc-950 hover:bg-white">
                    {createUser.isPending ? 'Creating...' : 'Create Account'}
                  </Button>
                ) : (
                  <Button onClick={() => handleCloseCreate(false)} className="bg-zinc-100 text-zinc-950 hover:bg-white">
                    Done
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
          <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Local Directory</CardTitle>
          <CardDescription className="text-xs text-zinc-500">Personnel authorized for edge-node access.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400">
              <thead className="text-xs text-zinc-500 uppercase tracking-wider bg-zinc-950/40 border-b border-zinc-800/60">
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
                    <td colSpan={4} className="px-6 py-12 text-center text-zinc-500 bg-zinc-950/20">
                      Loading crew directory...
                    </td>
                  </tr>
                ) : filteredUsers.length > 0 ? (
                  filteredUsers.map((user: any) => (
                    <tr key={user.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-all group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 bg-zinc-800 border border-zinc-700 shadow-sm">
                            <AvatarFallback className="text-zinc-300 bg-transparent text-xs font-semibold">{user.username.substring(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-zinc-200 group-hover:text-white transition-colors">{user.username}</div>
                            <div className="text-xs text-zinc-500">Edge Account</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {user.role.includes('Master') || user.role.includes('Admin') ? <ShieldAlert className="w-4 h-4 text-amber-500/80" /> : <Shield className="w-4 h-4 text-zinc-500" />}
                          <span className="text-zinc-300 font-medium">{user.role}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div 
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide uppercase border cursor-pointer hover:opacity-80 transition-opacity ${user.active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50'}`}
                          onClick={() => updateStatus.mutate({ id: user.id, active: !user.active })}
                        >
                          {user.active ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                          {user.active ? 'Active' : 'Inactive'}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))
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
    </div>
  );
}
