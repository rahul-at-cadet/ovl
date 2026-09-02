'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Ship, Search, Plus, Activity, Wifi, WifiOff, Edit, Trash2, Users, List, Map as MapIcon, KeyRound } from 'lucide-react';
import { Badge } from '@ovl/ui/components/badge';
import { VesselUsersDialog } from './VesselUsersDialog';

// Leaflet touches window/document at import time, so the map view can
// only ever run client-side — ssr: false keeps it out of the server
// render entirely rather than erroring on it.
const FleetMapView = dynamic(() => import('./FleetMapView').then((m) => m.FleetMapView), {
  ssr: false,
  loading: () => <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading map…</div>,
});
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ovl/ui/components/dialog';
import { Label } from '@ovl/ui/components/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ovl/ui/components/dropdown-menu';

import { trpc } from '@/lib/trpc';
import { validateImo } from '@/lib/imo';

export default function VesselsPage() {
  const [view, setView] = useState<'list' | 'map'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingVessel, setEditingVessel] = useState<any>(null);
  
  // Form State
  const [name, setName] = useState('');
  const [imo, setImo] = useState('');
  const [type, setType] = useState('');
  const [groups, setGroups] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [usersTarget, setUsersTarget] = useState<{ id: string; name: string } | null>(null);
  const [resetCredsTarget, setResetCredsTarget] = useState<{ id: string; name: string } | null>(null);

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

  const resetCredentialsMutation = trpc.vessels.resetCredentials.useMutation({
    onSuccess: () => {
      setResetCredsTarget(null);
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
    setGroups('');
    setIsDialogOpen(true);
  };

  const openEditDialog = (vessel: any) => {
    setEditingVessel(vessel);
    setName(vessel.name);
    setImo(vessel.imo);
    setType(vessel.type);
    setGroups((vessel.groups || []).join(', '));
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
  };

  // Only surface the error once the field is the length of a real IMO,
  // so it doesn't shout at someone who simply hasn't finished typing —
  // but Save stays disabled on any invalid value, matching the API,
  // which accepts no invalid IMO from any path.
  const imoTrimmed = imo.trim();
  const imoError = validateImo(imoTrimmed);
  const showImoError = imoTrimmed.length >= 7 && !!imoError;

  const handleSave = () => {
    if (imoError) return;
    const groupsArray = groups.split(',').map(g => g.trim()).filter(g => g);
    if (editingVessel) {
      updateMutation.mutate({ id: editingVessel.id, name, imo: imoTrimmed, type, groups: groupsArray });
    } else {
      createMutation.mutate({ name, imo: imoTrimmed, type, groups: groupsArray });
    }
  };

  const handleDelete = (id: string, name: string) => {
    setDeleteTarget({ id, name });
  };

  const confirmDelete = () => {
    if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
  };

  const confirmResetCredentials = () => {
    if (resetCredsTarget) resetCredentialsMutation.mutate({ id: resetCredsTarget.id });
  };

  return (
    // Fixed to the viewport, not the page — same fix as Reports/Users:
    // only the vessel table scrolls internally.
    // The lg variant used to subtract 168px, but the chrome above this
    // element actually measures 136px at every breakpoint (64px app bar
    // + 32px content padding + the shell's 40px pb-10) — the extra 32px
    // showed up as dead space under the table on wide screens, which is
    // exactly where the vessel list has the most rows to show. dvh
    // rather than vh so mobile browser chrome collapsing doesn't leave
    // the table overflowing behind it.
    <div className="h-[calc(100dvh-136px)] flex flex-col space-y-6 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Fleet Management</h1>
          <p className="text-muted-foreground mt-1.5 text-sm font-medium">Monitor vessel telemetry, edge node status, and sync operations.</p>
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          {view === 'list' && (
            <div className="relative w-full md:w-72">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by vessel name or IMO..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-sm w-full"
              />
            </div>
          )}
          <div className="flex rounded-md border border-border overflow-hidden shrink-0">
            <Button
              variant={view === 'list' ? 'secondary' : 'ghost'}
              onClick={() => setView('list')}
              className="h-9 rounded-none text-sm"
            >
              <List className="w-4 h-4 mr-2" />
              List
            </Button>
            <Button
              variant={view === 'map' ? 'secondary' : 'ghost'}
              onClick={() => setView('map')}
              className="h-9 rounded-none text-sm border-l border-border"
            >
              <MapIcon className="w-4 h-4 mr-2" />
              Map
            </Button>
          </div>
          <Button onClick={openNewDialog} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
            <Plus className="w-4 h-4 mr-2" />
            Provision Node
          </Button>
        </div>
      </div>

      {view === 'map' ? (
        <FleetMapView />
      ) : (
      <Card className="flex-1 flex flex-col bg-card border-border shadow-sm min-h-0 overflow-hidden rounded-md">
        <CardHeader className="border-b border-border pb-4 bg-card shrink-0">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Registered Vessels</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">Live overview of edge infrastructure across the fleet.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
          <div className="h-full overflow-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-card border-b border-border sticky top-0 z-10">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">Vessel Details</th>
                  <th scope="col" className="hidden md:table-cell px-4 py-2 font-semibold">IMO Number</th>
                  <th scope="col" className="hidden lg:table-cell px-4 py-2 font-semibold">Vessel Type</th>
                  <th scope="col" className="hidden lg:table-cell px-4 py-2 font-semibold">Tags</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Edge Node Status</th>
                  <th scope="col" className="hidden lg:table-cell px-4 py-2 font-semibold">Last Sync</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-muted-foreground bg-card">
                      Loading vessels...
                    </td>
                  </tr>
                ) : filteredVessels.length > 0 ? (
                  filteredVessels.map((vessel: any) => (
                    <tr key={vessel.id} className="border-b border-border hover:bg-muted transition-all group">
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
                      <td className="hidden md:table-cell px-4 py-2.5 font-mono text-xs tracking-wider text-foreground">
                        {vessel.imo}
                      </td>
                      <td className="hidden lg:table-cell px-4 py-2.5 text-foreground font-medium">
                        {vessel.type}
                      </td>
                      <td className="hidden lg:table-cell px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {(vessel.groups || []).map((g: string) => (
                            <Badge key={g} variant="outline" className="text-xs bg-muted/50">{g}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {vessel.edgeStatus === 'Online' && <Wifi className="w-4 h-4 text-status-ok" />}
                          {vessel.edgeStatus === 'Syncing' && <Activity className="w-4 h-4 text-status-info animate-pulse" />}
                          {vessel.edgeStatus === 'Offline' && <WifiOff className="w-4 h-4 text-status-critical" />}
                          <span className={`font-semibold text-xs uppercase tracking-wider ${
                            vessel.edgeStatus === 'Online' ? 'text-status-ok' :
                            vessel.edgeStatus === 'Syncing' ? 'text-status-info' : 'text-status-critical'
                          }`}>
                            {vessel.edgeStatus}
                          </span>
                        </div>
                      </td>
                      <td className="hidden lg:table-cell px-4 py-2.5 text-muted-foreground text-xs font-medium">
                        {vessel.lastSync}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon" aria-label={`Manage ${vessel.name}`} className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors" />
                            }
                          >
                            <Edit className="w-4 h-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48 bg-background border-border">
                            <DropdownMenuItem onClick={() => openEditDialog(vessel)} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-foreground">
                              <Edit className="mr-2 h-4 w-4" />
                              <span>Edit Vessel</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setUsersTarget({ id: vessel.id, name: vessel.name })} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-foreground">
                              <Users className="mr-2 h-4 w-4" />
                              <span>Manage Users</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setResetCredsTarget({ id: vessel.id, name: vessel.name })} className="hover:bg-muted cursor-pointer text-foreground focus:bg-muted focus:text-foreground">
                              <KeyRound className="mr-2 h-4 w-4" />
                              <span>Reset Credentials</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(vessel.id, vessel.name)} className="text-status-critical hover:bg-status-critical/10 cursor-pointer focus:bg-status-critical/10 focus:text-status-critical">
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
                    <td colSpan={7} className="px-6 py-12 text-center text-muted-foreground bg-card">
                      No vessels found matching &quot;{searchQuery}&quot;.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      )}

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
              <div className="col-span-3">
                <Input
                  id="imo"
                  value={imo}
                  onChange={(e) => setImo(e.target.value)}
                  inputMode="numeric"
                  maxLength={7}
                  placeholder="7 digits, e.g. 9074729"
                  aria-invalid={showImoError}
                  aria-describedby={showImoError ? 'imo-error' : undefined}
                  className={`w-full bg-card text-foreground ${showImoError ? 'border-status-critical' : 'border-border'}`}
                />
                {showImoError ? (
                  <p id="imo-error" role="alert" className="mt-1.5 text-xs text-status-critical">
                    {imoError}
                  </p>
                ) : null}
              </div>
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
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="groups" className="text-right text-muted-foreground">
                Tags
              </Label>
              <Input
                id="groups"
                value={groups}
                onChange={(e) => setGroups(e.target.value)}
                className="col-span-3 bg-card border-border text-foreground"
                placeholder="Comma separated tags (e.g. my-fleet, pacific)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} className="bg-transparent border-border text-foreground hover:bg-muted hover:text-foreground">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending || !!imoError} className="bg-primary hover:bg-primary/90 text-primary-foreground">
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
              variant="destructive"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Vessel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resetCredsTarget} onOpenChange={(open) => !open && setResetCredsTarget(null)}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Reset credentials?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{resetCredsTarget?.name}</span> will immediately stop
            syncing. Its sync credential is revoked, and it stays offline until someone re-runs its setup wizard
            with a valid provisioning key.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetCredsTarget(null)} className="bg-transparent border-border text-foreground hover:bg-muted hover:text-foreground">
              Cancel
            </Button>
            <Button
              onClick={confirmResetCredentials}
              disabled={resetCredentialsMutation.isPending}
              variant="destructive"
            >
              {resetCredentialsMutation.isPending ? 'Resetting...' : 'Reset Credentials'}
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
