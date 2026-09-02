"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@ovl/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ovl/ui/components/table";
import { Ship } from "lucide-react";
import { useEffect, useRef } from "react";

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

const RUN_CLASS: Record<string, string> = {
  served: "text-status-ok",
  noBundle: "text-status-warn",
  unknownVessel: "text-status-critical",
};

const RUN_LABEL: Record<string, string> = {
  served: "Served",
  noBundle: "No bundle",
  unknownVessel: "Unknown vessel",
};

export function VesselConfigsTab() {
  const { data: rows, isLoading } = trpc.configBundles.vesselConfigs.useQuery();
  /**
   * Check-in history, paged.
   *
   * useInfiniteQuery rather than a growing `limit`: the previous approach
   * re-requested every earlier row on each step (so the list visibly
   * re-rendered and jumped as pages arrived) and could never read past
   * the server's 200-row page cap. Accumulated pages stay mounted, so
   * appending a page does not disturb what is already on screen.
   */
  const HISTORY_PAGE = 25;
  const {
    data: historyPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.configBundles.syncHistory.useInfiniteQuery(
    { limit: HISTORY_PAGE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const history = historyPages?.pages.flatMap((p) => p.items) ?? [];

  /**
   * An IntersectionObserver on a sentinel row rather than a scroll
   * handler: it fires only when the end of the list is actually reached,
   * costs nothing while scrolling elsewhere, and needs no throttling.
   * Rooted on the scroll container, not the viewport — the list scrolls
   * inside a fixed-height box, so a viewport-rooted observer never fires.
   */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = scrollerRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      // A little early, so the next page is usually in place by the time
      // the reader reaches the bottom.
      { root, rootMargin: "120px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, history.length]);

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
                  <TableHead>Reported by ship</TableHead>
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
                    {/* What the ship calls itself on its own check-ins. enroll
                        matches vessels by IMO and keeps office's name, so the two
                        can diverge permanently — showing both is the only way
                        anyone finds out. */}
                    <TableCell className="text-xs">
                      {r.reportedName ? (
                        <span className={r.nameMismatch ? "text-status-warn font-medium" : "text-muted-foreground"}>
                          {r.reportedName}
                          {r.nameMismatch && " — differs"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not reported yet</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {r.imo}
                      {r.imoMismatch && (
                        <span className="block text-status-critical">ship reports {r.reportedImo}</span>
                      )}
                    </TableCell>
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

      {/* Shore-side check-in log. Unlike the table above, which shows only
          current state, this keeps every attempt — including check-ins from
          vessels office cannot identify, which previously left no trace at
          all and are the clearest signal that a ship needs re-enrolling. */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Check-in History</CardTitle>
          <CardDescription>Every sync attempt received, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-md">
              <Ship className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No check-ins recorded yet</p>
            </div>
          ) : (
            <div ref={scrollerRef} className="max-h-[26rem] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Received</TableHead>
                  <TableHead>Vessel</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Bundle served</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((run) => (
                  <TableRow key={run.id} className="border-border hover:bg-muted/50">
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(run.receivedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-foreground text-xs">
                      {run.displayName}
                      {run.nameMismatch && (
                        <span className="block text-status-warn">ship says “{run.reportedName}”</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className={`text-xs font-medium ${RUN_CLASS[run.outcome] ?? ""}`}>
                        {RUN_LABEL[run.outcome] ?? run.outcome}
                      </span>
                      {/* The note only exists for the outcomes that failed,
                          so it belongs with the outcome rather than in a
                          column of its own that is empty for every served
                          check-in. */}
                      {run.note ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{run.note}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                      {run.resolvedBundleId ? `v${run.resolvedBundleVersion}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Sentinel — scrolling it into view fetches the next page.
                Inside the scroll container so the observer can be rooted
                on it. */}
            <div ref={sentinelRef} aria-hidden className="h-px" />

            {hasNextPage ? (
              <p className="py-3 text-center text-xs text-muted-foreground" role="status">
                {isFetchingNextPage ? "Loading more…" : "Scroll for more"}
              </p>
            ) : (
              <p className="py-3 text-center text-xs text-muted-foreground">
                Showing all {history.length} check-in{history.length === 1 ? "" : "s"}.
              </p>
            )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
