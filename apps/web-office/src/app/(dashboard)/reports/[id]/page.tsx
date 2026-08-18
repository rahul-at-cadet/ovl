'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, CheckCircle, XCircle, Clock, FileText, User, Ship } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { trpc } from '@/lib/trpc';

export default function ReportDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { data: report, isLoading, error } = trpc.reports.get.useQuery({ reportId: id });

  if (isLoading) {
    return <div className="p-8 text-center text-slate-400">Loading report details...</div>;
  }

  if (error || !report) {
    return <div className="p-8 text-center text-red-400">Error loading report: {error?.message || 'Not found'}</div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      <div className="flex items-center text-sm text-slate-400 mb-4">
        <Link href="/reports" className="hover:text-indigo-400 flex items-center transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Ledger
        </Link>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-900/50 p-6 rounded-xl border border-slate-800 shadow-lg backdrop-blur-sm">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-slate-800 rounded-lg border border-slate-700">
            <FileText className="w-8 h-8 text-indigo-400" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-slate-100">{report.type}</h1>
              <Badge variant="outline" className="bg-orange-500/10 text-orange-400 border-orange-500/20 uppercase tracking-widest text-[10px]">
                {report.status.replace('_', ' ')}
              </Badge>
            </div>
            <p className="text-slate-400 mt-1 font-mono text-sm">ID: {report.id}</p>
          </div>
        </div>

        <div className="flex gap-3 w-full md:w-auto">
          <Button variant="outline" className="flex-1 md:flex-none border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300">
            <XCircle className="w-4 h-4 mr-2" />
            Reject
          </Button>
          <Button className="flex-1 md:flex-none bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-500/20">
            <CheckCircle className="w-4 h-4 mr-2" />
            Approve Report
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Metadata Sidebar */}
        <div className="space-y-6">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader>
              <CardTitle className="text-lg">Audit Trail</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 text-sm">
                <Ship className="w-4 h-4 text-slate-500" />
                <div className="flex flex-col">
                  <span className="text-slate-400">Vessel</span>
                  <span className="text-slate-200 font-medium">{report.vessel} ({report.imo})</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <User className="w-4 h-4 text-slate-500" />
                <div className="flex flex-col">
                  <span className="text-slate-400">Submitted By</span>
                  <span className="text-slate-200 font-medium">{report.author}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Clock className="w-4 h-4 text-slate-500" />
                <div className="flex flex-col">
                  <span className="text-slate-400">Timestamp</span>
                  <span className="text-slate-200 font-medium">{new Date(report.submittedAt).toLocaleString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Data Payload */}
        <div className="md:col-span-2 space-y-6">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader className="border-b border-slate-800 pb-4">
              <CardTitle>Report Payload</CardTitle>
              <CardDescription>Read-only view of the data submitted from the edge.</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-8">
                {Object.entries(report.fields).map(([key, value]) => (
                  <div key={key} className="border-b border-slate-800/50 pb-3">
                    <dt className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">
                      {key.replace(/_/g, ' ')}
                    </dt>
                    <dd className="text-slate-200 font-medium">
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
