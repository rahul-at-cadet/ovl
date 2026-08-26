"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@ovl/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ovl/ui/components/table";
import { Ship } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  unassigned: "Unassigned",
  pendingSync: "Pending Sync",
  synced: "Synced",
  outOfDate: "Out of Date",
};

const STATUS_CLASS: Record<string, string> = {
  unassigned: "text-muted-foreground bg-muted/60",
  pendingSync: "text-status-warn bg-status-warn/10",
  synced: "text-status-ok bg-status-ok/10",
  outOfDate: "text-status-critical bg-status-critical/10",
};

export function VesselConfigsTab() {
  const { data: rows, isLoading } = trpc.configBundles.vesselConfigs.useQuery();

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Vessel Configs</CardTitle>
          <CardDescription>Each vessel&apos;s assigned bundle vs. what it last reported running.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-muted-foreground">Loading vessel configs...</div>
          ) : rows?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-md">
              <Ship className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No vessels found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Vessel</TableHead>
                  <TableHead>IMO</TableHead>
                  <TableHead>Bundle</TableHead>
                  <TableHead>Active Since</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.map((r) => (
                  <TableRow key={r.vesselId} className="border-border hover:bg-muted/50">
                    <TableCell className="font-medium text-foreground">{r.vesselName}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{r.imo}</TableCell>
                    <TableCell className="text-muted-foreground">{r.assignedBundleLabel || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
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
