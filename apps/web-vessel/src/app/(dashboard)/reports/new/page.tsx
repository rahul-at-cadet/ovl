'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants, Button } from '@/components/ui/button';
import { ArrowRight, Fuel, ClipboardList, TrendingUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToastManager } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// Cargo Nomination is deliberately absent — it's office-authored only
// (via the Commercial screen), never something the vessel creates.
// Bunker Report and EDN Report have no event/cadence concept and are
// created directly; Log Abstract is the only schema with a real event
// concept and can't be created without picking one (see EventPickerDialog
// below) — mirrors ovl/web/vessel/src/screens/EventPickerDialog.tsx's own
// comment on why only Log Abstract goes through this dialog.
const availableReports = [
  { id: 'bunker-report.json', title: 'Bunker Report', description: 'Log fuel intake and quality metrics.', icon: Fuel, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', needsEvent: false },
  { id: 'edn-report.json', title: 'EDN Report', description: 'Daily noon reporting and engine diagnostics.', icon: ClipboardList, color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/20', needsEvent: false },
  { id: 'log-abstract.json', title: 'Log Abstract', description: 'End of voyage logging and speed performance.', icon: TrendingUp, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20', needsEvent: true },
];

export default function NewReportPage() {
  const router = useRouter();
  const toastManager = useToastManager();
  const [startingSchema, setStartingSchema] = useState<string | null>(null);
  const [eventPickerFor, setEventPickerFor] = useState<string | null>(null);

  const { data: eventTypes = [] } = trpc.reports.getEnum.useQuery(
    { name: 'event-types' },
    { enabled: eventPickerFor !== null },
  );

  const createReportMutation = trpc.reports.createReport.useMutation({
    onSuccess: (res) => {
      router.push(`/reports/${res.reportId}`);
    },
    onError: (err) => {
      toastManager.add({ title: 'Failed to start draft', description: err.message, type: 'error' });
      setStartingSchema(null);
    }
  });

  const startDraft = (schemaId: string, eventType: string, seedEventField: boolean) => {
    setStartingSchema(schemaId);
    createReportMutation.mutate({
      schemaName: schemaId,
      eventType,
      eventTime: new Date().toISOString(),
      // Log Abstract's own "Event" field (enumRef: event-types) mirrors
      // the report's top-level eventType — pre-filled here so ReportForm
      // can lock it, matching the original's "no way to ever set it
      // afterward, start a new report to change it" behavior.
      fields: seedEventField ? { Event: eventType } : {},
    });
  };

  const handleStartDraft = (report: (typeof availableReports)[number]) => {
    if (report.needsEvent) {
      setEventPickerFor(report.id);
      return;
    }
    startDraft(report.id, report.id.replace('.json', ''), false);
  };

  const handlePickEvent = (code: string) => {
    if (!eventPickerFor) return;
    const schemaId = eventPickerFor;
    setEventPickerFor(null);
    startDraft(schemaId, code, true);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Create New Report</h1>
        <p className="text-muted-foreground mt-1">Select the type of report you need to file.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {availableReports.map((report) => (
          <Card key={report.id} className="bg-card/50 border-border hover:border-border transition-all group overflow-hidden relative flex flex-col h-full">
            <div className={`absolute top-0 right-0 w-32 h-32 blur-3xl opacity-20 group-hover:opacity-40 transition-opacity pointer-events-none ${report.bg.split(' ')[0]}`} />
            
            <CardHeader className="flex flex-row items-start gap-4 flex-1">
              <div className={`p-3 rounded-xl border ${report.bg} shrink-0`}>
                <report.icon className={`w-6 h-6 ${report.color}`} />
              </div>
              <div className="space-y-1">
                <CardTitle>{report.title}</CardTitle>
                <CardDescription className="text-muted-foreground line-clamp-2">
                  {report.description}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex justify-end pt-4 border-t border-border/50 mt-2 relative z-10">
              <Button
                onClick={() => handleStartDraft(report)}
                disabled={startingSchema === report.id}
                className={cn(buttonVariants({ variant: 'secondary' }), "w-full sm:w-auto bg-muted hover:bg-zinc-700 text-foreground")}
              >
                {startingSchema === report.id ? 'Starting...' : 'Start Draft'}
                {startingSchema === report.id ? <Loader2 className="w-4 h-4 ml-2 shrink-0 animate-spin" /> : <ArrowRight className="w-4 h-4 ml-2 shrink-0" />}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={eventPickerFor !== null} onOpenChange={(open) => !open && setEventPickerFor(null)}>
        <DialogContent className="sm:max-w-[420px] max-h-[70vh] overflow-y-auto bg-background border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">Choose an event</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Log Abstract needs an event before it can be created — this can&apos;t be changed later; start a new
              report instead if it was wrong.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col divide-y divide-border/50">
            {eventTypes.map((code: string) => (
              <button
                key={code}
                onClick={() => handlePickEvent(code)}
                className="text-left py-2.5 px-1 text-sm text-foreground hover:bg-muted rounded-md transition-colors"
              >
                {code}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
