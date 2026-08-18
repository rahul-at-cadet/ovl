'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, CheckCircle2, Clock, FileText, User, Ship } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { trpc } from '@/lib/trpc';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-zinc-500/10 text-muted-foreground border-zinc-500/20',
  submitted: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
};

export default function ReportDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const utils = trpc.useUtils();
  const { data: report, isLoading, error } = trpc.reports.get.useQuery({ reportId: id });
  const markReviewed = trpc.reports.markReviewed.useMutation({
    onSuccess: () => utils.reports.get.invalidate({ reportId: id }),
  });

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading report details...</div>;
  }

  if (error || !report) {
    return <div className="p-8 text-center text-red-400">Error loading report: {error?.message || 'Not found'}</div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      <div className="flex items-center text-sm text-muted-foreground mb-4">
        <Link href="/reports" className="hover:text-indigo-400 flex items-center transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Ledger
        </Link>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card/50 p-6 rounded-xl border border-border shadow-lg backdrop-blur-sm">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-muted rounded-lg border border-border">
            <FileText className="w-8 h-8 text-indigo-400" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{report.type}</h1>
              <Badge variant="outline" className={`${STATUS_CLASS[report.status] ?? 'bg-orange-500/10 text-orange-400 border-orange-500/20'} uppercase tracking-widest text-[10px]`}>
                {STATUS_LABEL[report.status] ?? report.status.replace('_', ' ')}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 font-mono text-sm">ID: {report.id}</p>
          </div>
        </div>

        <div className="flex gap-3 w-full md:w-auto">
          {report.reviewed ? (
            <span className="flex items-center gap-2 text-sm text-emerald-400 px-3 py-2">
              <CheckCircle2 className="w-4 h-4" />
              Reviewed by {report.reviewedBy}
            </span>
          ) : (
            <Button
              onClick={() => markReviewed.mutate({ reportId: id })}
              disabled={markReviewed.isPending}
              className="flex-1 md:flex-none bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20"
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {markReviewed.isPending ? 'Marking...' : 'Mark Reviewed'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Metadata Sidebar */}
        <div className="space-y-6">
          <Card className="bg-card/50 border-border">
            <CardHeader>
              <CardTitle className="text-lg">Audit Trail</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 text-sm">
                <Ship className="w-4 h-4 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-muted-foreground">Vessel</span>
                  <span className="text-foreground font-medium">{report.vessel} ({report.imo})</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <User className="w-4 h-4 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-muted-foreground">Submitted By</span>
                  <span className="text-foreground font-medium">{report.author}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-muted-foreground">Timestamp</span>
                  <span className="text-foreground font-medium">{new Date(report.submittedAt).toLocaleString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Data Payload */}
        <div className="md:col-span-2 space-y-6">
          <Card className="bg-card/50 border-border">
            <CardHeader className="border-b border-border pb-4">
              <CardTitle>Report Payload</CardTitle>
              <CardDescription>Read-only view of the data submitted from the edge.</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-8">
                {Object.entries(report.fields).map(([key, value]) => (
                  <div key={key} className="border-b border-border/50 pb-3">
                    <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      {key.replace(/_/g, ' ')}
                    </dt>
                    <dd className="text-foreground font-medium">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
