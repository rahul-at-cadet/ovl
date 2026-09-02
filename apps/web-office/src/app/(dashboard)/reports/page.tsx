'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ovl/ui/components/table';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ovl/ui/components/select';
import { Search, FileText, ChevronRight, CheckCircle2, Download, Loader2, Flag, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

// See apps/web-office/src/app/(dashboard)/page.tsx's own comment on
// why this can't be a plain <a href>/window.open download — this
// app's session transport is header-based, not cookie-based.
function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function GlobalReportsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [vesselFilter, setVesselFilter] = useState('all');
  const [schemaFilter, setSchemaFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [remarksOnly, setRemarksOnly] = useState(false);

  // Debounced so each keystroke doesn't start a new paged query; the
  // filters now run server-side, so every change is a round trip.
  // Option lists for the vessel/schema selects. Small, cached queries —
  // the fleet and the curated schema set are both bounded.
  const { data: vesselOptions = [] } = trpc.vessels.list.useQuery();
  const { data: schemaOptions = [] } = trpc.schemas.list.useQuery();

  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const utils = trpc.useUtils();
  /**
   * Paged with useInfiniteQuery. reports.list previously returned a
   * silently truncated first 100 rows, so the ledger simply ended with no
   * indication that it had; pages now accumulate as the table is scrolled.
   */
  const REPORTS_PAGE = 50;
  const {
    data: reportPages,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.reports.list.useInfiniteQuery(
    {
      limit: REPORTS_PAGE,
      // Filtering has to happen server-side now that the list is paged:
      // filtering the loaded pages in the browser would only ever search
      // the rows already fetched, silently hiding matches further down.
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(statusFilter !== 'all' ? { state: statusFilter } : {}),
      ...(vesselFilter !== 'all' ? { vesselId: vesselFilter } : {}),
      ...(schemaFilter !== 'all' ? { schema: schemaFilter } : {}),
      ...(dateFrom ? { dateFrom: new Date(dateFrom).toISOString() } : {}),
      // Inclusive of the chosen day: a bare date parses to midnight, which
      // would exclude everything that happened during it.
      ...(dateTo ? { dateTo: new Date(dateTo + 'T23:59:59.999Z').toISOString() } : {}),
      ...(remarksOnly ? { hasRemarks: true } : {}),
    },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const reports = reportPages?.pages.flatMap((p) => p.items) ?? [];

  // Sentinel-based infinite scroll, rooted on the table's own scroll box
  // (the page itself never scrolls, so a viewport-rooted observer would
  // never fire).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = scrollerRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { root, rootMargin: '200px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, reports.length]);
  const markReviewed = trpc.reports.markReviewed.useMutation({
    onSuccess: () => utils.reports.list.invalidate(),
  });
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const { csv, filename } = await utils.reports.exportCsv.fetch();
      downloadCsv(csv, filename);
    } finally {
      setIsExporting(false);
    }
  };

  // The server already applied every filter, so the rows are the result.
  const filteredReports = reports;

  const activeFilterCount =
    (debouncedSearch ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0) +
    (vesselFilter !== 'all' ? 1 : 0) +
    (schemaFilter !== 'all' ? 1 : 0) +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0) +
    (remarksOnly ? 1 : 0);

  // Base UI's <Select.Value> renders the raw value, not the chosen item's
  // text, unless the root is given an items map — without these the
  // triggers read "all" and a bare vessel UUID instead of their labels.
  const statusItems: Record<string, string> = {
    all: 'All Statuses',
    draft: 'Draft',
    submitted: 'Submitted',
    remarked: 'Remarked',
    invalidated: 'Invalidated',
  };
  const vesselItems: Record<string, string> = {
    all: 'All Vessels',
    ...Object.fromEntries((vesselOptions as { id: string; name: string }[]).map((v) => [v.id, v.name])),
  };
  const schemaItems: Record<string, string> = {
    all: 'All Schemas',
    ...Object.fromEntries(
      (schemaOptions as { schemaName: string }[]).map((sc) => [sc.schemaName, sc.schemaName.replace(/\.json$/, '')]),
    ),
  };

  const clearFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setVesselFilter('all');
    setSchemaFilter('all');
    setDateFrom('');
    setDateTo('');
    setRemarksOnly(false);
  };

  return (
    // Fixed to the viewport, not the page — a ledger with hundreds of
    // fleet reports shouldn't require scrolling past the header/filters
    // just to see the table; only the table body scrolls internally.
    // 136px is the measured chrome at every breakpoint (64px app bar +
    // 32px content padding + the shell's 40px pb-10); the lg override
    // subtracted 32px too many and left dead space under the table.
    <div className="h-[calc(100dvh-136px)] flex flex-col space-y-6 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Global Reports Ledger</h1>
          <p className="text-muted-foreground mt-1">Audit and review all incoming vessel reports.</p>
        </div>
      </div>

      <Card className="flex-1 flex flex-col bg-card border-border shadow-sm min-h-0 overflow-hidden">
        <CardHeader className="pb-3 border-b border-border shrink-0">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <CardTitle>Fleet Reports</CardTitle>
              <Button
                variant="outline"
                onClick={handleExport}
                disabled={isExporting}
                className="h-9 border-border bg-card text-muted-foreground hover:text-foreground shrink-0"
              >
                {isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                Export CSV
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by IMO or Vessel..."
                  className="pl-9 bg-card border-border h-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select items={statusItems} value={statusFilter} onValueChange={(val) => setStatusFilter(val || 'all')}>
                <SelectTrigger className="w-[150px] h-9 bg-card border-border text-foreground">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  {/* States the ledger actually contains — the previous
                      two-value select could not express "show me what went
                      wrong", which is the reason to open this screen. */}
                  <SelectItem value="remarked">Remarked</SelectItem>
                  <SelectItem value="invalidated">Invalidated</SelectItem>
                </SelectContent>
              </Select>

              <Select items={vesselItems} value={vesselFilter} onValueChange={(val) => setVesselFilter(val || 'all')}>
                <SelectTrigger className="w-[170px] h-9 bg-card border-border text-foreground">
                  <SelectValue placeholder="Vessel" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  <SelectItem value="all">All Vessels</SelectItem>
                  {vesselOptions.map((v: { id: string; name: string }) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select items={schemaItems} value={schemaFilter} onValueChange={(val) => setSchemaFilter(val || 'all')}>
                <SelectTrigger className="w-[170px] h-9 bg-card border-border text-foreground">
                  <SelectValue placeholder="Schema" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  <SelectItem value="all">All Schemas</SelectItem>
                  {schemaOptions.map((sc: { schemaName: string }) => (
                    <SelectItem key={sc.schemaName} value={sc.schemaName}>{sc.schemaName.replace(/\.json$/, '')}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Dates filter on event time — when it happened at sea, not
                  when shore received it; after an outage those differ by
                  the length of the outage. */}
              <Input
                type="date"
                aria-label="Event date from"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 w-[150px] bg-card border-border text-foreground"
              />
              <Input
                type="date"
                aria-label="Event date to"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 w-[150px] bg-card border-border text-foreground"
              />

              <Button
                variant={remarksOnly ? 'default' : 'outline'}
                onClick={() => setRemarksOnly((v) => !v)}
                aria-pressed={remarksOnly}
                className={`h-9 shrink-0 ${remarksOnly ? '' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
              >
                <Flag className="mr-2 h-4 w-4" />
                Remarked
              </Button>

              {activeFilterCount > 0 ? (
                <Button
                  variant="ghost"
                  onClick={clearFilters}
                  className="h-9 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="mr-1.5 h-4 w-4" />
                  Clear ({activeFilterCount})
                </Button>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
          <div ref={scrollerRef} className="h-full overflow-auto">
            <Table>
              <TableHeader className="bg-card sticky top-0 z-10">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="hidden md:table-cell text-muted-foreground font-medium">Report ID</TableHead>
                <TableHead className="text-muted-foreground font-medium">Vessel / IMO</TableHead>
                <TableHead className="hidden md:table-cell text-muted-foreground font-medium">Type</TableHead>
                <TableHead className="text-muted-foreground font-medium">Status</TableHead>
                <TableHead className="hidden md:table-cell text-muted-foreground font-medium">Date Received</TableHead>
                <TableHead className="hidden md:table-cell text-muted-foreground font-medium">Reviewed</TableHead>
                <TableHead className="text-right text-muted-foreground font-medium">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    Loading reports...
                  </TableCell>
                </TableRow>
              ) : filteredReports.length > 0 ? (
                // align-top on the cells: the Vessel column is two lines (name
                // over IMO) while every other column is one, and the default
                // align-middle centres that taller block — leaving the bold
                // vessel name ~7px above the report id, type, status and date,
                // which reads as the row being out of line with its headers.
                // Topping them out lines every first line up. py-3 keeps the
                // row height.
                filteredReports.map((report: any) => (
                  <TableRow
                    key={report.id}
                    className="border-border hover:bg-muted transition-colors group [&>td]:align-top [&>td]:py-3"
                  >
                  <TableCell className="hidden md:table-cell font-medium text-foreground font-mono text-sm">
                    {report.id}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground">{report.vessel}</span>
                      <span className="text-xs text-muted-foreground">IMO {report.imo}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex items-center text-foreground">
                      <FileText className="w-4 h-4 text-muted-foreground mr-2" />
                      {report.type}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={report.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">{report.date}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {report.reviewed ? (
                      <span className="flex items-center gap-1.5 text-xs text-status-ok">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Reviewed
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={markReviewed.isPending}
                        onClick={() => markReviewed.mutate({ reportId: report.id })}
                        className="text-muted-foreground hover:text-foreground text-xs h-7"
                      >
                        Mark Reviewed
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/reports/${report.id}`}>
                      {/* pr-0: this is the trailing cell of a right-aligned
                          column, and the button's own 10px right padding sat
                          between the chevron and the cell edge — so the glyphs
                          stopped 11px short of where the "Action" header text
                          ends, and the column read as misaligned. Dropping it
                          puts the chevron flush with the header. */}
                      <Button variant="ghost" size="sm" className="pr-0 text-muted-foreground hover:text-primary">
                        Audit <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    No reports found matching your criteria.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {/* Scrolling this into view fetches the next page. */}
          <div ref={sentinelRef} aria-hidden className="h-px" />
          {hasNextPage ? (
            <p className="py-3 text-center text-xs text-muted-foreground" role="status">
              {isFetchingNextPage ? 'Loading more…' : 'Scroll for more'}
            </p>
          ) : reports.length > 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              Showing all {reports.length} report{reports.length === 1 ? '' : 's'}.
            </p>
          ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
