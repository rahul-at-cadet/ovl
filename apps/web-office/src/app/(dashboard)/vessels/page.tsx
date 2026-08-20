'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Ship, Search, ArrowUpDown, Filter, Plus, Activity, Wifi, WifiOff, Edit, Trash2, Users } from 'lucide-react';
import { VesselUsersDialog } from './VesselUsersDialog';
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
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [usersTarget, setUsersTarget] = useState<{ id: string; name: string } | null>(null);

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
      setDeleteTarget(null);
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

  const handleDelete = (id: string, name: string) => {
    setDeleteTarget({ id, name });
  };

  const confirmDelete = () => {
    if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
  };

  return (
    // Fixed to the viewport, not the page — same fix as Reports/Users:
    // only the vessel table scrolls internally.
    <div className="h-[calc(100vh-140px)] flex flex-col space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border/60 pb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Fleet Management</h1>
          <p className="text-muted-foreground mt-1.5 text-sm font-medium">Monitor vessel telemetry, edge node status, and sync operations.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-72 shadow-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search by vessel name or IMO..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-background/80 border-border/80 focus-visible:ring-ring text-foreground rounded-md h-9 text-sm w-full transition-all"
            />
          </div>
          <Button onClick={openNewDialog} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
            <Plus className="w-4 h-4 mr-2" />
            Provision Node
          </Button>
        </div>
      </div>

      <Card className="flex-1 flex flex-col bg-card/40 border-border/60 shadow-xl min-h-0 overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-border/60 pb-4 bg-card/20 shrink-0">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Registered Vessels</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">Live overview of edge infrastructure across the fleet.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
          <div className="h-full overflow-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-background/90 backdrop-blur-sm border-b border-border/60 sticky top-0 z-10">
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
                    <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground bg-background/20">
                      Loading vessels...
                    </td>
                  </tr>
                ) : filteredVessels.length > 0 ? (
                  filteredVessels.map((vessel: any) => (
                    <tr key={vessel.id} className="border-b border-border/40 hover:bg-muted/20 transition-all group">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-md bg-muted border border-border shadow-sm shrink-0">
                            <Ship className="w-4 h-4 text-foreground" />
                          </div>
                          <div>
                            <div className="font-semibold text-foreground group-hover:text-foreground transition-colors">{vessel.name}</div>
                            <div className="text-xs text-muted-foreground">{vessel.status}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs tracking-wider text-foreground">
                        {vessel.imo}
                      </td>
                      <td className="px-4 py-2.5 text-foreground font-medium">
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
                      <td className="px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        {vessel.lastSync}
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
                            <DropdownMenuItem onClick={() => openEditDialog(vessel)} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-white">
                              <Edit className="mr-2 h-4 w-4" />
                              <span>Edit Vessel</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setUsersTarget({ id: vessel.id, name: vessel.name })} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-white">
                              <Users className="mr-2 h-4 w-4" />
                              <span>Manage Users</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(vessel.id, vessel.name)} className="text-red-400 hover:bg-red-500/10 cursor-pointer focus:bg-red-500/10 focus:text-red-400">
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
                    <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground bg-background/20">
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
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editingVessel ? 'Edit Vessel' : 'Provision New Vessel'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right text-muted-foreground">
                Name
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="col-span-3 bg-card border-border text-foreground"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="imo" className="text-right text-muted-foreground">
                IMO
              </Label>
              <Input
                id="imo"
                value={imo}
                onChange={(e) => setImo(e.target.value)}
                className="col-span-3 bg-card border-border text-foreground"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="type" className="text-right text-muted-foreground">
                Type
              </Label>
              <Input
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="col-span-3 bg-card border-border text-foreground"
                placeholder="e.g. Tanker"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} className="bg-transparent border-border text-foreground hover:bg-muted hover:text-foreground">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {editingVessel ? 'Save Changes' : 'Provision'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Delete vessel?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove <span className="font-medium text-foreground">{deleteTarget?.name}</span> and
            its edge enrollment. This action cannot be undone.
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
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Vessel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {usersTarget ? (
        <VesselUsersDialog
          vesselId={usersTarget.id}
          vesselName={usersTarget.name}
          open={usersTarget !== null}
          onOpenChange={(open) => !open && setUsersTarget(null)}
        />
      ) : null}
    </div>
  );
}
