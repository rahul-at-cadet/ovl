'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Filter, FileText, ChevronRight, Download } from 'lucide-react';

export default function GlobalReportsPage() {
  const [searchQuery, setSearchQuery] = useState('');

  // Mock global data
  const reports = [
    { id: 'f17976f1', vessel: 'Seawise Giant', imo: '7381154', type: 'Bunker Report', status: 'pending_review', date: '2026-08-15', by: 'vessel-admin' },
    { id: '36582434', vessel: 'Emma Maersk', imo: '9321483', type: 'EDN Report', status: 'approved', date: '2026-08-15', by: 'captain-john' },
    { id: 'b8281dfd', vessel: 'TI Europe', imo: '9235268', type: 'Log Abstract', status: 'approved', date: '2026-08-14', by: 'vessel-admin' },
    { id: 'c9392eec', vessel: 'Batillus', imo: '7360148', type: 'Cargo Nomination', status: 'rejected', date: '2026-08-13', by: 'chief-mate' },
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-100">Global Reports Ledger</h1>
          <p className="text-slate-400 mt-1">Audit, review, and export all incoming vessel reports.</p>
        </div>
        <Button variant="outline" className="border-slate-700 bg-slate-900 text-slate-300 hover:text-white">
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <Card className="bg-slate-900/50 border-slate-800 shadow-xl">
        <CardHeader className="pb-3 border-b border-slate-800/50">
          <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
            <CardTitle>Fleet Reports</CardTitle>
            <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
              <div className="relative w-full lg:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
                <Input
                  placeholder="Search by IMO or Vessel..."
                  className="pl-9 bg-slate-950/50 border-slate-800 h-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select defaultValue="all">
                <SelectTrigger className="w-[140px] h-9 bg-slate-950/50 border-slate-800 text-slate-200">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800 text-slate-200">
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending_review">Pending Review</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="h-9 w-9 border-slate-800 bg-slate-950/50 text-slate-400 hover:text-slate-100">
                <Filter className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-slate-950/30">
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-400 font-medium">Report ID</TableHead>
                <TableHead className="text-slate-400 font-medium">Vessel / IMO</TableHead>
                <TableHead className="text-slate-400 font-medium">Type</TableHead>
                <TableHead className="text-slate-400 font-medium">Status</TableHead>
                <TableHead className="text-slate-400 font-medium">Date Received</TableHead>
                <TableHead className="text-right text-slate-400 font-medium">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id} className="border-slate-800 hover:bg-slate-800/30 transition-colors group">
                  <TableCell className="font-medium text-slate-300 font-mono text-sm">
                    {report.id}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-semibold text-slate-200">{report.vessel}</span>
                      <span className="text-xs text-slate-500">IMO {report.imo}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center text-slate-300">
                      <FileText className="w-4 h-4 text-slate-500 mr-2" />
                      {report.type}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`
                      ${report.status === 'approved' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 
                        report.status === 'rejected' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 
                        'bg-orange-500/10 text-orange-400 border-orange-500/20'}
                    `}>
                      {report.status === 'pending_review' ? 'Pending Review' : 
                       report.status.charAt(0).toUpperCase() + report.status.slice(1)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-400">{report.date}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/reports/${report.id}`}>
                      <Button variant="ghost" size="sm" className="text-slate-400 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
                        Audit <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
