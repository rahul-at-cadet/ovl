'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Ship, Globe, Anchor, Save } from 'lucide-react';
import { trpc } from '@/lib/trpc';

export default function SetupPage() {
  const { data: setupStatus } = trpc.setup.status.useQuery();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-4xl mx-auto">
      <div className="border-b border-zinc-800/60 pb-6 text-center mt-8">
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-zinc-900 border border-zinc-800 shadow-sm rounded-xl">
            <Anchor className="w-8 h-8 text-blue-400" />
          </div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Vessel Node Initialization</h1>
        <p className="text-zinc-400 mt-1.5 text-sm font-medium">Configure this edge node with the vessel&apos;s identity and shore-side uplink.</p>
      </div>

      <Card className="bg-zinc-900/40 border-zinc-800/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
        <CardHeader className="border-b border-zinc-800/60 pb-4 bg-zinc-900/20">
          <CardTitle className="text-sm font-semibold tracking-tight text-zinc-200">Identity Configuration</CardTitle>
          <CardDescription className="text-xs text-zinc-500">Must exactly match the shore-side registry.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Vessel Name</Label>
              <div className="relative">
                <Ship className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                <Input defaultValue="Seawise Giant" className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10" />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">IMO Number</Label>
              <Input defaultValue="7381154" className="bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10 font-mono tracking-wider" />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Shore Uplink URL</Label>
            <div className="relative">
              <Globe className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <Input defaultValue="https://api.ovl.com/v1/sync" className="pl-9 bg-zinc-950/80 border-zinc-800/80 focus-visible:ring-zinc-700 text-zinc-100 text-sm h-10 font-mono" />
            </div>
          </div>
        </CardContent>
        <CardFooter className="bg-zinc-950/40 border-t border-zinc-800/60 p-4 flex justify-between items-center">
          <p className="text-xs text-zinc-500 flex items-center gap-1.5">
            Status: 
            <span className={setupStatus?.isConfigured ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
              {setupStatus?.isConfigured ? 'Configured' : 'Pending Setup'}
            </span>
          </p>
          <Button className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 rounded-md h-9 text-sm font-semibold transition-all">
            <Save className="w-4 h-4 mr-2" />
            Save Configuration
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
