'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Plus, FileText, ChevronRight, ArrowUpDown, ChevronLeft, ChevronRight as ChevronRightIcon } from 'lucide-react';
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
    <div className="h-[calc(100vh-140px)] flex flex-col space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">Reports</h1>
          <p className="text-zinc-400 mt-1">Manage and submit your vessel reports.</p>
        </div>
        <Link href="/reports/new">
          <Button className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20">
            <Plus className="w-4 h-4 mr-2" />
            New Report
          </Button>
        </Link>
      </div>

      <Card className="flex-1 flex flex-col bg-zinc-900/50 border-zinc-800 min-h-0 overflow-hidden">
        <CardHeader className="pb-3 border-b border-zinc-800/50 shrink-0">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <CardTitle>All Reports</CardTitle>
            <div className="flex flex-col sm:flex-row items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
                <Input
                  placeholder="Search reports..."
                  className="pl-9 bg-zinc-950/50 border-zinc-800 h-9"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                />
              </div>
              <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val || 'all'); setCurrentPage(1); }}>
                <SelectTrigger className="w-full sm:w-40 bg-zinc-950/50 border-zinc-800 h-9 text-zinc-300">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="bg-zinc-950 border-zinc-800">
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="ready">Ready</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        
        <CardContent className="flex-1 p-0 flex flex-col min-h-0 overflow-hidden relative">
          <div className="flex-1 overflow-auto">
            <Table>
              <TableHeader className="bg-zinc-950/90 backdrop-blur-sm sticky top-0 z-10">
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="text-zinc-400 font-medium">Type</TableHead>
                  <TableHead className="text-zinc-400 font-medium">Event</TableHead>
                  <TableHead className="text-zinc-400 font-medium cursor-pointer hover:text-zinc-200 transition-colors" onClick={toggleSort}>
                    <div className="flex items-center">
                      UTC Timestamp
                      <ArrowUpDown className="w-3 h-3 ml-2" />
                    </div>
                  </TableHead>
                  <TableHead className="text-zinc-400 font-medium">Voyage</TableHead>
                  <TableHead className="text-zinc-400 font-medium">State</TableHead>
                  <TableHead className="text-right text-zinc-400 font-medium">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  // Skeleton Loading State
                  Array.from({ length: ITEMS_PER_PAGE }).map((_, i) => (
                    <TableRow key={i} className="border-zinc-800">
                      <TableCell><div className="h-4 w-32 bg-zinc-800/50 animate-pulse rounded"></div></TableCell>
                      <TableCell><div className="h-4 w-24 bg-zinc-800/50 animate-pulse rounded"></div></TableCell>
                      <TableCell><div className="h-4 w-36 bg-zinc-800/50 animate-pulse rounded"></div></TableCell>
                      <TableCell><div className="h-4 w-20 bg-zinc-800/50 animate-pulse rounded"></div></TableCell>
                      <TableCell><div className="h-5 w-20 bg-zinc-800/50 animate-pulse rounded-full"></div></TableCell>
                      <TableCell className="text-right"><div className="h-8 w-16 bg-zinc-800/50 animate-pulse rounded ml-auto"></div></TableCell>
                    </TableRow>
                  ))
                ) : error ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-red-500">
                      Failed to load reports.
                    </TableCell>
                  </TableRow>
                ) : paginatedReports.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-zinc-500">
                      No reports match your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedReports.map((report) => (
                    <TableRow key={report.reportId} className="border-zinc-800 hover:bg-zinc-800/30 transition-colors group">
                      <TableCell className="font-medium">
                        <div className="flex items-center">
                          <FileText className="w-4 h-4 text-zinc-500 mr-2" />
                          {report.schemaName}
                          <span className="ml-2 text-xs text-zinc-600 font-mono">#{report.reportId.slice(0, 8)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-zinc-400">{report.eventType || '-'}</TableCell>
                      <TableCell className="text-zinc-400 font-mono text-sm">{new Date(report.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                      <TableCell className="text-zinc-400">{(report as any).voyageNumber || '-'}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border ${
                          report.state === 'submitted' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                          report.state === 'draft' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                          'bg-blue-500/10 text-blue-400 border-blue-500/20'
                        }`}>
                          {report.state.charAt(0).toUpperCase() + report.state.slice(1)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/reports/${report.reportId}`}>
                          <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                            View <ChevronRight className="w-4 h-4 ml-1" />
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          
          {/* Pagination Controls */}
          {!isLoading && filteredAndSortedReports.length > 0 && (
            <div className="border-t border-zinc-800/50 p-4 bg-zinc-950/30 flex items-center justify-between shrink-0">
              <div className="text-sm text-zinc-500">
                Showing <span className="font-medium text-zinc-300">{(currentPage - 1) * ITEMS_PER_PAGE + 1}</span> to <span className="font-medium text-zinc-300">{Math.min(currentPage * ITEMS_PER_PAGE, filteredAndSortedReports.length)}</span> of <span className="font-medium text-zinc-300">{filteredAndSortedReports.length}</span> results
              </div>
              <div className="flex items-center space-x-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="h-8 border-zinc-800 bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Prev
                </Button>
                <div className="text-sm text-zinc-400 font-medium px-2">
                  Page {currentPage} of {totalPages}
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="h-8 border-zinc-800 bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"
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
