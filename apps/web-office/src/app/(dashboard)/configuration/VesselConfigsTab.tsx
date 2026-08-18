"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Ship } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  unassigned: "Unassigned",
  pendingSync: "Pending Sync",
  synced: "Synced",
  outOfDate: "Out of Date",
};

const STATUS_CLASS: Record<string, string> = {
  unassigned: "text-slate-400 bg-slate-800/60",
  pendingSync: "text-amber-300 bg-amber-950/40",
  synced: "text-emerald-300 bg-emerald-950/40",
  outOfDate: "text-red-300 bg-red-950/40",
};

export function VesselConfigsTab() {
  const { data: rows, isLoading } = trpc.configBundles.vesselConfigs.useQuery();

  return (
    <div className="space-y-6">
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-slate-100 text-base">Vessel Configs</CardTitle>
          <CardDescription>Each vessel&apos;s assigned bundle vs. what it last reported running.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-slate-400">Loading vessel configs...</div>
          ) : rows?.length === 0 ? (
            <div className="text-center py-12 text-slate-500 border-dashed border-slate-800 rounded-lg">
              <Ship className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No vessels found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead>Vessel</TableHead>
                  <TableHead>IMO</TableHead>
                  <TableHead>Bundle</TableHead>
                  <TableHead>Active Since</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.map((r) => (
                  <TableRow key={r.vesselId} className="border-slate-800 hover:bg-slate-800/50">
                    <TableCell className="font-medium text-slate-200">{r.vesselName}</TableCell>
                    <TableCell className="text-slate-500 font-mono text-xs">{r.imo}</TableCell>
                    <TableCell className="text-slate-400">{r.assignedBundleLabel || "—"}</TableCell>
                    <TableCell className="text-slate-400">
                      {r.activeSince ? new Date(r.activeSince).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_CLASS[r.status]}`}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
