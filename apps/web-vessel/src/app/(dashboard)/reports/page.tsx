'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Plus, Filter, FileText, ChevronRight, Loader2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

export default function ReportsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  
  // Use tRPC to query the backend
  const { data: reports = [], isLoading, error } = trpc.reports.listReports.useQuery({
    schemaName: '' // Fetch all schemas for now
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
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

      <Card className="bg-zinc-900/50 border-zinc-800">
        <CardHeader className="pb-3 border-b border-zinc-800/50">
          <div className="flex items-center justify-between">
            <CardTitle>All Reports</CardTitle>
            <div className="flex items-center space-x-2">
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
                <Input
                  placeholder="Search reports..."
                  className="pl-9 bg-zinc-950/50 border-zinc-800 h-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" className="h-9 w-9 border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:text-zinc-100">
                <Filter className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-zinc-950/30">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400 font-medium">Type</TableHead>
                <TableHead className="text-zinc-400 font-medium">Status</TableHead>
                <TableHead className="text-zinc-400 font-medium">Date</TableHead>
                <TableHead className="text-zinc-400 font-medium">Author</TableHead>
                <TableHead className="text-right text-zinc-400 font-medium">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-zinc-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                    <span className="mt-2 block text-xs">Loading reports...</span>
                  </TableCell>
                </TableRow>
              ) : error ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-red-500">
                    Failed to load reports.
                  </TableCell>
                </TableRow>
              ) : reports.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-zinc-500">
                    No reports found.
                  </TableCell>
                </TableRow>
              ) : (
                reports.filter(r => r.schemaName.includes(searchQuery) || r.reportId.includes(searchQuery)).map((report) => (
                  <TableRow key={report.reportId} className="border-zinc-800 hover:bg-zinc-800/30 transition-colors group">
                    <TableCell className="font-medium">
                      <div className="flex items-center">
                        <FileText className="w-4 h-4 text-zinc-500 mr-2" />
                        {report.schemaName}
                        <span className="ml-2 text-xs text-zinc-600 font-mono">#{report.reportId.slice(0, 8)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border ${
                        report.state === 'submitted' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                        report.state === 'draft' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                        'bg-blue-500/10 text-blue-400 border-blue-500/20'
                      }`}>
                        {report.state.charAt(0).toUpperCase() + report.state.slice(1)}
                      </span>
                    </TableCell>
                    <TableCell className="text-zinc-400">{new Date(report.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-zinc-400">{report.createdBy}</TableCell>
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
        </CardContent>
      </Card>
    </div>
  );
}
