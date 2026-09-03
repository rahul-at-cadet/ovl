"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@ovl/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ovl/ui/components/table";
import { Ship, Search, ArrowUpDown } from "lucide-react";
import { Button } from "@ovl/ui/components/button";
import { Input } from "@ovl/ui/components/input";
import { useEffect, useRef, useState } from "react";

/** One figure in the check-in summary strip. */
function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          tone === "ok" ? "text-status-ok" : tone === "warn" ? "text-status-warn" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** Toggle for one outcome. `aria-pressed` rather than a checkbox: these
 *  read as a segmented control, and the count sits inside the label. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-9 items-center rounded-md border px-2.5 text-xs font-medium transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

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

  // Filtering and ordering are server-side. This table grows by one row
  // per vessel per cycle, so anything done in the browser would only ever
  // filter or sort the pages that happen to be loaded — which looks like
  // it works right up until the fleet is big enough to matter.
  const [outcomeFilter, setOutcomeFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');

  // Debounced so a filter change does not fire a request per keystroke;
  // the value the queries actually key on is this one, not the input.
  const [appliedSearch, setAppliedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAppliedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const historyFilters = {
    ...(outcomeFilter ? { outcomes: [outcomeFilter] } : {}),
    ...(appliedSearch ? { search: appliedSearch } : {}),
  };

  const { data: outcomeOptions = [] } = trpc.configBundles.syncOutcomes.useQuery();
  // Metrics describe the whole filtered set, not the loaded pages, so
  // they are a separate call that only re-runs when the filters change.
  const { data: metrics } = trpc.configBundles.syncMetrics.useQuery(historyFilters);

  const {
    data: historyPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.configBundles.syncHistory.useInfiniteQuery(
    { ...historyFilters, sort, limit: HISTORY_PAGE },
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
        <CardHeader className="space-y-4">
          <div>
            <CardTitle className="text-foreground text-base">Check-in History</CardTitle>
            <CardDescription>Every sync attempt received from the fleet.</CardDescription>
          </div>

          {/* Counted over everything matching the filters, not over the
              rows loaded so far — a summary that described the current
              page would change as you scrolled. */}
          {metrics ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Check-ins" value={metrics.total.toLocaleString()} />
              <Metric label="Vessels" value={String(metrics.vessels)} />
              <Metric
                label="Succeeded"
                value={metrics.successRate === null ? '—' : `${metrics.successRate}%`}
                tone={metrics.successRate === null ? undefined : metrics.successRate >= 95 ? 'ok' : 'warn'}
              />
              {/* Two tiles, not one. A check-in with no bundle assigned is
                  a configuration gap fixed in Assignments; a failed one is
                  a vessel office cannot identify. Showing them together as
                  "Failed" reported a healthy but unconfigured fleet as
                  entirely broken. */}
              <Metric
                label={metrics.failed > 0 ? 'Failed' : 'No bundle'}
                value={(metrics.failed > 0 ? metrics.failed : metrics.unconfigured).toLocaleString()}
                tone={metrics.failed > 0 ? 'warn' : metrics.unconfigured > 0 ? 'warn' : undefined}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search vessel or IMO…"
                aria-label="Search check-ins by vessel or IMO"
                className="h-9 pl-8"
              />
            </div>

            {/* Built from the outcomes actually present rather than a
                hardcoded list, so an outcome added server-side shows up
                here without a UI change. */}
            <div className="flex flex-wrap gap-1.5">
              <FilterChip active={outcomeFilter === null} onClick={() => setOutcomeFilter(null)}>
                All
              </FilterChip>
              {outcomeOptions.map((o) => (
                <FilterChip
                  key={o}
                  active={outcomeFilter === o}
                  onClick={() => setOutcomeFilter(outcomeFilter === o ? null : o)}
                >
                  {RUN_LABEL[o] ?? o}
                  {metrics ? (
                    <span className="ml-1.5 tabular-nums opacity-70">
                      {metrics.byOutcome.find((b) => b.outcome === o)?.count ?? 0}
                    </span>
                  ) : null}
                </FilterChip>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              onClick={() => setSort(sort === 'newest' ? 'oldest' : 'newest')}
              aria-label={`Sort by time, currently ${sort === 'newest' ? 'newest' : 'oldest'} first`}
            >
              <ArrowUpDown className="mr-1.5 size-3.5" />
              {sort === 'newest' ? 'Newest' : 'Oldest'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-md">
              <Ship className="w-8 h-8 mx-auto mb-3 opacity-50" />
              {/* Filtered to nothing is a different problem from having no
                  data, and only one of them is fixed by clearing a filter. */}
              {outcomeFilter || appliedSearch ? (
                <>
                  <p>No check-ins match these filters.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setOutcomeFilter(null);
                      setSearch('');
                    }}
                  >
                    Clear filters
                  </Button>
                </>
              ) : (
                <p>No check-ins recorded yet</p>
              )}
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
