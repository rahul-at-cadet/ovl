'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Filter, FileText, ChevronRight, CheckCircle2, Download, Loader2 } from 'lucide-react';
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

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-zinc-500/10 text-muted-foreground border-zinc-500/20',
  submitted: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
};

export default function GlobalReportsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const utils = trpc.useUtils();
  const { data: reports = [], isLoading } = trpc.reports.list.useQuery();
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

  const filteredReports = reports.filter((report: any) => {
    const matchesSearch = report.vessel.toLowerCase().includes(searchQuery.toLowerCase()) || report.imo.includes(searchQuery);
    const matchesStatus = statusFilter === 'all' || report.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    // Fixed to the viewport, not the page — a ledger with hundreds of
    // fleet reports shouldn't require scrolling past the header/filters
    // just to see the table; only the table body scrolls internally.
    <div className="h-[calc(100vh-136px)] lg:h-[calc(100vh-168px)] flex flex-col space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Global Reports Ledger</h1>
          <p className="text-muted-foreground mt-1">Audit and review all incoming vessel reports.</p>
        </div>
      </div>

      <Card className="flex-1 flex flex-col bg-card/50 border-border shadow-xl min-h-0 overflow-hidden">
        <CardHeader className="pb-3 border-b border-border/50 shrink-0">
          <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
            <CardTitle>Fleet Reports</CardTitle>
            <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
              <div className="relative w-full lg:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by IMO or Vessel..."
                  className="pl-9 bg-background/50 border-border h-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={(val) => setStatusFilter(val || 'all')}>
                <SelectTrigger className="w-[140px] h-9 bg-background/50 border-border text-foreground">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="h-9 w-9 border-border bg-background/50 text-muted-foreground hover:text-foreground">
                <Filter className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                onClick={handleExport}
                disabled={isExporting}
                className="h-9 border-border bg-background/50 text-muted-foreground hover:text-foreground shrink-0"
              >
                {isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
                Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden">
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader className="bg-background/90 backdrop-blur-sm sticky top-0 z-10">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground font-medium">Report ID</TableHead>
                <TableHead className="text-muted-foreground font-medium">Vessel / IMO</TableHead>
                <TableHead className="text-muted-foreground font-medium">Type</TableHead>
                <TableHead className="text-muted-foreground font-medium">Status</TableHead>
                <TableHead className="text-muted-foreground font-medium">Date Received</TableHead>
                <TableHead className="text-muted-foreground font-medium">Reviewed</TableHead>
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
                filteredReports.map((report: any) => (
                  <TableRow key={report.id} className="border-border hover:bg-muted/30 transition-colors group">
                  <TableCell className="font-medium text-foreground font-mono text-sm">
                    {report.id}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground">{report.vessel}</span>
                      <span className="text-xs text-muted-foreground">IMO {report.imo}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center text-foreground">
                      <FileText className="w-4 h-4 text-muted-foreground mr-2" />
                      {report.type}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={STATUS_CLASS[report.status] ?? 'bg-orange-500/10 text-orange-400 border-orange-500/20'}>
                      {STATUS_LABEL[report.status] ?? (report.status.charAt(0).toUpperCase() + report.status.slice(1))}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{report.date}</TableCell>
                  <TableCell>
                    {report.reviewed ? (
                      <span className="flex items-center gap-1.5 text-xs text-emerald-400">
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
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary">
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
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
