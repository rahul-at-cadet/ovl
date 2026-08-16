'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { ArrowRight, Anchor, Fuel, ClipboardList, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

const availableReports = [
  { id: 'bunker-report.json', title: 'Bunker Report', description: 'Log fuel intake and quality metrics.', icon: Fuel, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' },
  { id: 'cargo-nomination.json', title: 'Cargo Nomination', description: 'Declare cargo handling operations.', icon: Anchor, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  { id: 'edn-report.json', title: 'EDN Report', description: 'Daily noon reporting and engine diagnostics.', icon: ClipboardList, color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/20' },
  { id: 'log-abstract.json', title: 'Log Abstract', description: 'End of voyage logging and speed performance.', icon: TrendingUp, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
];

export default function NewReportPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-100">Create New Report</h1>
        <p className="text-zinc-400 mt-1">Select the type of report you need to file.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {availableReports.map((report) => (
          <Card key={report.id} className="bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 transition-all group overflow-hidden relative flex flex-col h-full">
            <div className={`absolute top-0 right-0 w-32 h-32 blur-3xl opacity-20 group-hover:opacity-40 transition-opacity pointer-events-none ${report.bg.split(' ')[0]}`} />
            
            <CardHeader className="flex flex-row items-start gap-4 flex-1">
              <div className={`p-3 rounded-xl border ${report.bg} shrink-0`}>
                <report.icon className={`w-6 h-6 ${report.color}`} />
              </div>
              <div className="space-y-1">
                <CardTitle>{report.title}</CardTitle>
                <CardDescription className="text-zinc-400 line-clamp-2">
                  {report.description}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex justify-end pt-4 border-t border-zinc-800/50 mt-2 relative z-10">
              <Link 
                href={`/reports/draft?schema=${report.id}`}
                className={cn(buttonVariants({ variant: 'secondary' }), "w-full sm:w-auto bg-zinc-800 hover:bg-zinc-700 text-zinc-100")}
              >
                Start Draft
                <ArrowRight className="w-4 h-4 ml-2 shrink-0" />
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
