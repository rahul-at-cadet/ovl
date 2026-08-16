'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Ship, Search, MoreHorizontal, ArrowUpDown, Filter, Plus, Activity, Wifi, WifiOff } from 'lucide-react';


const MOCK_VESSELS = [
  { id: 'v-001', name: 'Seawise Giant', imo: '7381154', type: 'ULCC', status: 'At Sea', edgeStatus: 'Online', lastSync: '2 mins ago' },
  { id: 'v-002', name: 'Emma Maersk', imo: '9321483', type: 'Container', status: 'In Port', edgeStatus: 'Online', lastSync: '5 mins ago' },
  { id: 'v-003', name: 'TI Europe', imo: '9235268', type: 'ULCC', status: 'Underway', edgeStatus: 'Syncing', lastSync: '12 mins ago' },
  { id: 'v-004', name: 'Batillus', imo: '7360148', type: 'Supertanker', status: 'Dry Dock', edgeStatus: 'Offline', lastSync: '3 days ago' },
  { id: 'v-005', name: 'Pioneering Spirit', imo: '9593505', type: 'Crane', status: 'At Sea', edgeStatus: 'Online', lastSync: 'Just now' },
];

export default function VesselsPage() {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredVessels = MOCK_VESSELS.filter(vessel => 
    vessel.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    vessel.imo.includes(searchQuery)
  );

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
          <Button variant="outline" className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:text-white hover:bg-zinc-900 rounded-md h-9 shadow-sm shrink-0">
            <Filter className="w-4 h-4 mr-2" />
            Filter
          </Button>
          <Button className="bg-zinc-100 hover:bg-white text-zinc-950 rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 transition-all">
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
                  <th scope="col" className="px-6 py-3 font-semibold flex items-center gap-2">Vessel Details <ArrowUpDown className="w-3 h-3" /></th>
                  <th scope="col" className="px-6 py-3 font-semibold">IMO Number</th>
                  <th scope="col" className="px-6 py-3 font-semibold">Vessel Type</th>
                  <th scope="col" className="px-6 py-3 font-semibold">Edge Node Status</th>
                  <th scope="col" className="px-6 py-3 font-semibold">Last Sync</th>
                  <th scope="col" className="px-6 py-3 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {filteredVessels.length > 0 ? (
                  filteredVessels.map((vessel) => (
                    <tr key={vessel.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-all group">
                      <td className="px-6 py-4">
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
                      <td className="px-6 py-4 font-mono text-xs tracking-wider text-zinc-300">
                        {vessel.imo}
                      </td>
                      <td className="px-6 py-4 text-zinc-300 font-medium">
                        {vessel.type}
                      </td>
                      <td className="px-6 py-4">
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
                      <td className="px-6 py-4 text-zinc-400 text-xs font-medium">
                        {vessel.lastSync}
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
    </div>
  );
}
