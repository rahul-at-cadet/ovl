'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Ship, Search, ArrowUpDown, Filter, Plus, Activity, Wifi, WifiOff, Edit, Trash2 } from 'lucide-react';
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

export default function VesselsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingVessel, setEditingVessel] = useState<any>(null);
  
  // Form State
  const [name, setName] = useState('');
  const [imo, setImo] = useState('');
  const [type, setType] = useState('');

  const utils = trpc.useUtils();
  const { data: vessels = [], isLoading } = trpc.vessels.list.useQuery();
  
  const createMutation = trpc.vessels.create.useMutation({
    onSuccess: () => {
      utils.vessels.list.invalidate();
      closeDialog();
    }
  });

  const updateMutation = trpc.vessels.update.useMutation({
    onSuccess: () => {
      utils.vessels.list.invalidate();
      closeDialog();
    }
  });

  const deleteMutation = trpc.vessels.delete.useMutation({
    onSuccess: () => {
      utils.vessels.list.invalidate();
    }
  });

  const filteredVessels = vessels.filter((vessel: any) => 
    vessel.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    vessel.imo.includes(searchQuery)
  );

  const openNewDialog = () => {
    setEditingVessel(null);
    setName('');
    setImo('');
    setType('');
    setIsDialogOpen(true);
  };

  const openEditDialog = (vessel: any) => {
    setEditingVessel(vessel);
    setName(vessel.name);
    setImo(vessel.imo);
    setType(vessel.type);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
  };

  const handleSave = () => {
    if (editingVessel) {
      updateMutation.mutate({ id: editingVessel.id, name, imo, type });
    } else {
      createMutation.mutate({ name, imo, type, groups: [] });
    }
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this vessel? This action cannot be undone.')) {
      deleteMutation.mutate({ id });
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800/60 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Fleet Management</h1>
          <p className="text-zinc-400 mt-1.5 text-sm font-medium">Monitor vessel telemetry, edge node status, and sync operations.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-72 shadow-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
            <Input 
              placeholder="Search by vessel name or IMO..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 rounded-md h-9 text-sm w-full transition-all"
            />
          </div>
          <Button onClick={openNewDialog} className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
            <Plus className="w-4 h-4 mr-2" />
            Provision Node
          </Button>
        </div>
      </div>

      <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
          <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Registered Vessels</CardTitle>
          <CardDescription className="text-xs text-zinc-500">Live overview of edge infrastructure across the fleet.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-zinc-400">
              <thead className="text-xs text-zinc-500 uppercase tracking-wider bg-zinc-950/40 border-b border-zinc-800/60">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold flex items-center gap-2">Vessel Details <ArrowUpDown className="w-3 h-3" /></th>
                  <th scope="col" className="px-4 py-2 font-semibold">IMO Number</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Vessel Type</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Edge Node Status</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Last Sync</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-zinc-500 bg-zinc-950/20">
                      Loading vessels...
                    </td>
                  </tr>
                ) : filteredVessels.length > 0 ? (
                  filteredVessels.map((vessel: any) => (
                    <tr key={vessel.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-all group">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-md bg-zinc-800 border border-zinc-700 shadow-sm shrink-0">
                            <Ship className="w-4 h-4 text-zinc-300" />
                          </div>
                          <div>
                            <div className="font-semibold text-zinc-200 group-hover:text-white transition-colors">{vessel.name}</div>
                            <div className="text-xs text-zinc-500">{vessel.status}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs tracking-wider text-zinc-300">
                        {vessel.imo}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-300 font-medium">
                        {vessel.type}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {vessel.edgeStatus === 'Online' && <Wifi className="w-4 h-4 text-emerald-400" />}
                          {vessel.edgeStatus === 'Syncing' && <Activity className="w-4 h-4 text-blue-400 animate-pulse" />}
                          {vessel.edgeStatus === 'Offline' && <WifiOff className="w-4 h-4 text-red-400" />}
                          <span className={`font-semibold text-xs uppercase tracking-wider ${
                            vessel.edgeStatus === 'Online' ? 'text-emerald-400' : 
                            vessel.edgeStatus === 'Syncing' ? 'text-blue-400' : 'text-red-400'
                          }`}>
                            {vessel.edgeStatus}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-400 text-xs font-medium">
                        {vessel.lastSync}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors">
                              <Edit className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 bg-zinc-950 border-zinc-800">
                            <DropdownMenuItem onClick={() => openEditDialog(vessel)} className="hover:bg-zinc-800 cursor-pointer text-zinc-300 focus:bg-zinc-800 focus:text-white">
                              <Edit className="mr-2 h-4 w-4" />
                              <span>Edit Vessel</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(vessel.id)} className="text-red-400 hover:bg-red-500/10 cursor-pointer focus:bg-red-500/10 focus:text-red-400">
                              <Trash2 className="mr-2 h-4 w-4" />
                              <span>Delete Vessel</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-zinc-500 bg-zinc-950/20">
                      No vessels found matching &quot;{searchQuery}&quot;.
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
            <DialogTitle className="text-zinc-100">{editingVessel ? 'Edit Vessel' : 'Provision New Vessel'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right text-zinc-400">
                Name
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="col-span-3 bg-zinc-900 border-zinc-800 text-zinc-100"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="imo" className="text-right text-zinc-400">
                IMO
              </Label>
              <Input
                id="imo"
                value={imo}
                onChange={(e) => setImo(e.target.value)}
                className="col-span-3 bg-zinc-900 border-zinc-800 text-zinc-100"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="type" className="text-right text-zinc-400">
                Type
              </Label>
              <Input
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="col-span-3 bg-zinc-900 border-zinc-800 text-zinc-100"
                placeholder="e.g. Tanker"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} className="bg-transparent border-zinc-800 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {editingVessel ? 'Save Changes' : 'Provision'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
