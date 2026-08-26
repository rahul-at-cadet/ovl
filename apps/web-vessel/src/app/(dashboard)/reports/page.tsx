'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ovl/ui/components/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ovl/ui/components/select';
import { Search, Plus, FileText, ChevronRight, ArrowUp, ArrowDown, ChevronLeft, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { trpc } from '@/lib/trpc';

const ITEMS_PER_PAGE = 10;

export default function ReportsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [currentPage, setCurrentPage] = useState(1);
  
  // Use tRPC to query the backend
  const { data: reports = [], isLoading, error } = trpc.reports.listReports.useQuery({
    schemaName: '' // Fetch all schemas for now
  });

  const filteredAndSortedReports = useMemo(() => {
    let result = reports;

    // Filter by Search Query
    if (searchQuery) {
      const lowerQuery = searchQuery.toLowerCase();
      result = result.filter(r => 
        r.schemaName.toLowerCase().includes(lowerQuery) || 
        r.reportId.toLowerCase().includes(lowerQuery) ||
        ((r as any).voyageNumber && (r as any).voyageNumber.toLowerCase().includes(lowerQuery)) ||
        (r.eventType && r.eventType.toLowerCase().includes(lowerQuery))
      );
    }

    // Filter by Status
    if (statusFilter !== 'all') {
      result = result.filter(r => r.state === statusFilter);
    }

    // Sort by Date
    result = [...result].sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });

    return result;
  }, [reports, searchQuery, statusFilter, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSortedReports.length / ITEMS_PER_PAGE));
  
  // Ensure current page is valid when filters change
  if (currentPage > totalPages && totalPages > 0) {
    setCurrentPage(totalPages);
  }

  const paginatedReports = filteredAndSortedReports.slice(
    (currentPage - 1) * ITEMS_PER_PAGE, 
    currentPage * ITEMS_PER_PAGE
  );

  const toggleSort = () => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');

  return (
    <div className="flex flex-col gap-4 pb-4 xl:pb-0 xl:h-[calc(100vh_-_88px)] xl:overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 shrink-0">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
                  </div>
        <Link href="/reports/new" className="w-full sm:w-auto">
          <Button className="w-full sm:w-auto justify-center px-5">
            <Plus className="w-5 h-5 mr-2" />
            New Report
          </Button>
        </Link>
      </div>

      <Card className="flex flex-col border-border bg-card rounded-sm xl:flex-1 xl:min-h-0 xl:overflow-hidden">
        <CardHeader className="border-b border-border px-4 py-3 shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="contents">
              <div className="relative w-full sm:flex-1 sm:max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search reports..."
                  className="pl-9 w-full"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                />
              </div>
              <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val || 'all'); setCurrentPage(1); }}>
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="bg-background border-border">
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="ready">Ready</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        
        <CardContent className="p-0 flex flex-col xl:flex-1 xl:min-h-0">
          <ul className="md:hidden divide-y divide-border border-b border-border">
            {isLoading ? (
              <li className="p-4 text-sm text-muted-foreground">Loading reports…</li>
            ) : error ? (
              <li className="p-4 text-sm text-status-critical">Failed to load reports.</li>
            ) : paginatedReports.length === 0 ? (
              <li className="p-4 text-sm text-muted-foreground">No reports match your filters.</li>
            ) : (
              paginatedReports.map((report) => (
                <li key={report.reportId}>
                  <Link
                    href={`/reports/${report.reportId}`}
                    className="flex flex-col gap-2 p-4 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium text-foreground break-all">{report.schemaName}</span>
                      </span>
                      <StatusBadge status={report.state} size="sm" className="shrink-0" />
                    </span>
                    <span className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="readout break-all">#{report.reportId.slice(0, 8)}</span>
                      <span className="break-words">{report.eventType || '—'}</span>
                      <span className="readout col-span-2">
                        {new Date(report.createdAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
                      </span>
                      {(report as any).voyageNumber && (
                        <span className="col-span-2 break-words">Voyage {(report as any).voyageNumber}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </ul>

          <div className="hidden md:block overflow-x-auto xl:overflow-y-auto border-b border-border xl:flex-1 xl:min-h-0">
            <Table>
              <TableHeader className="bg-muted sticky top-0 z-10">
                <TableRow className="border-b-2 border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground font-medium">Type</TableHead>
                  <TableHead className="hidden md:table-cell text-muted-foreground font-medium">Event</TableHead>
                  {/* A click handler on the <th> itself took no keyboard
                      focus and announced no sort state. A real button inside
                      the header cell does both, and aria-sort is what tells a
                      screen reader which way the column is currently ordered. */}
                  <TableHead
                    aria-sort={sortOrder === 'asc' ? 'ascending' : 'descending'}
                    className="hidden lg:table-cell text-muted-foreground font-medium p-0"
                  >
                    <button
                      type="button"
                      onClick={toggleSort}
                      className="flex items-center w-full min-h-11 px-2 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    >
                      UTC Timestamp
                      {sortOrder === 'asc' ? (
                        <ArrowUp className="w-3 h-3 ml-2" />
                      ) : (
                        <ArrowDown className="w-3 h-3 ml-2" />
                      )}
                      <span className="sr-only">
                        {sortOrder === 'asc' ? '(oldest first)' : '(newest first)'}
                      </span>
                    </button>
                  </TableHead>
                  <TableHead className="hidden lg:table-cell text-muted-foreground font-medium">Voyage</TableHead>
                  <TableHead className="text-muted-foreground font-medium">State</TableHead>
                  <TableHead className="text-right text-muted-foreground font-medium pr-4">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  // Skeleton Loading State
                  Array.from({ length: ITEMS_PER_PAGE }).map((_, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell><div className="h-4 w-32 bg-muted animate-pulse rounded"></div></TableCell>
                      <TableCell className="hidden md:table-cell"><div className="h-4 w-24 bg-muted animate-pulse rounded"></div></TableCell>
                      <TableCell className="hidden lg:table-cell"><div className="h-4 w-36 bg-muted animate-pulse rounded"></div></TableCell>
                      <TableCell className="hidden lg:table-cell"><div className="h-4 w-20 bg-muted animate-pulse rounded"></div></TableCell>
                      <TableCell><div className="h-8 w-24 bg-muted animate-pulse rounded-sm"></div></TableCell>
                      <TableCell className="text-right pr-4"><div className="h-8 w-16 bg-muted animate-pulse rounded-sm ml-auto"></div></TableCell>
                    </TableRow>
                  ))
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-status-critical">
                      Failed to load reports.
                    </TableCell>
                  </TableRow>
                ) : paginatedReports.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      No reports match your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedReports.map((report) => (
                    <TableRow key={report.reportId} className="border-border hover:bg-accent transition-colors">
                      <TableCell className="font-medium">
                        <div className="flex items-center">
                          <FileText className="w-4 h-4 text-muted-foreground mr-2" />
                          {report.schemaName}
                          <span className="ml-2 text-xs text-muted-foreground font-mono">#{report.reportId.slice(0, 8)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{report.eventType || '-'}</TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground font-mono text-sm">{new Date(report.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">{(report as any).voyageNumber || '-'}</TableCell>
                      <TableCell>
                        <StatusBadge status={report.state} />
                      </TableCell>
                      <TableCell className="text-right pr-4">
                        <Button
                          variant="ghost"
                          render={<Link href={`/reports/${report.reportId}`} />}
                          nativeButton={false}
                          className="text-muted-foreground hover:text-primary pr-0"
                        >
                          View <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          
          {/* Pagination Controls */}
          {!isLoading && filteredAndSortedReports.length > 0 && (
            <div className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
              <div className="text-sm text-muted-foreground">
                Showing <span className="font-medium text-foreground">{(currentPage - 1) * ITEMS_PER_PAGE + 1}</span> to <span className="font-medium text-foreground">{Math.min(currentPage * ITEMS_PER_PAGE, filteredAndSortedReports.length)}</span> of <span className="font-medium text-foreground">{filteredAndSortedReports.length}</span> results
              </div>
              <div className="flex items-center space-x-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="flex-1 sm:flex-none justify-center"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Prev
                </Button>
                <div className="text-sm text-muted-foreground font-medium px-2">
                  Page {currentPage} of {totalPages}
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="flex-1 sm:flex-none justify-center"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                  <ChevronRightIcon className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
