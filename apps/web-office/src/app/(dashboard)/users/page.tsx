'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, UserPlus, Search, MoreHorizontal, UserCheck, ShieldAlert, ArrowUpDown, Filter } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

const MOCK_USERS = [
  { id: 1, name: 'Alice Chen', email: 'alice.c@ovl.com', role: 'Super Admin', status: 'Active', avatar: 'AC' },
  { id: 2, name: 'Marcus Johnson', email: 'marcus.j@ovl.com', role: 'Fleet Manager', status: 'Active', avatar: 'MJ' },
  { id: 3, name: 'Sarah Williams', email: 'sarah.w@ovl.com', role: 'Vessel Captain', status: 'Active', avatar: 'SW' },
  { id: 4, name: 'David Kim', email: 'david.k@ovl.com', role: 'Engineer', status: 'Inactive', avatar: 'DK' },
];

export default function UsersPage() {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredUsers = MOCK_USERS.filter(user => 
    user.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    user.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
              placeholder="Search by name, email, or role..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 rounded-md h-9 text-sm w-full transition-all"
            />
          </div>
          <Button variant="outline" className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:text-white hover:bg-zinc-900 rounded-md h-9 shadow-sm shrink-0">
            <Filter className="w-4 h-4 mr-2" />
            Filter
          </Button>
          <Button className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
            <UserPlus className="w-4 h-4 mr-2" />
            Provision User
          </Button>
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
                  <th scope="col" className="px-6 py-3 font-semibold flex items-center gap-2">User <ArrowUpDown className="w-3 h-3" /></th>
                  <th scope="col" className="px-6 py-3 font-semibold">Security Role</th>
                  <th scope="col" className="px-6 py-3 font-semibold">Account Status</th>
                  <th scope="col" className="px-6 py-3 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length > 0 ? (
                  filteredUsers.map((user) => (
                    <tr key={user.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-all group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 bg-zinc-800 border border-zinc-700 shadow-sm">
                            <AvatarFallback className="text-zinc-300 bg-transparent text-xs font-semibold">{user.avatar}</AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-zinc-200 group-hover:text-white transition-colors">{user.name}</div>
                            <div className="text-xs text-zinc-500">{user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {user.role.includes('Admin') ? <ShieldAlert className="w-4 h-4 text-amber-500/80" /> : <Shield className="w-4 h-4 text-zinc-500" />}
                          <span className="text-zinc-300 font-medium">{user.role}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide uppercase border ${user.status === 'Active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50'}`}>
                          {user.status === 'Active' && <UserCheck className="w-3 h-3" />}
                          {user.status}
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
