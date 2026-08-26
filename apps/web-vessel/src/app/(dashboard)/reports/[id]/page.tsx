'use client';

import { useParams, useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Loader2, ArrowLeft, Send, MessageSquare, History, FileText, Pencil, Flag } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useScrollActiveTabIntoView } from '@/components/ScrollableTabs';
import { ReportForm } from '@/components/ReportForm';
import { AuditTimeline, type AuditEvent } from '@/components/AuditTimeline';
import { useToastManager } from '@ovl/ui/components/toast';

export default function ReportDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const detailTabsRef = useScrollActiveTabIntoView<HTMLDivElement>();
  const toastManager = useToastManager();
  const utils = trpc.useUtils();

  const { data: report, isLoading, error } = trpc.reports.getReport.useQuery({ id });
  const { data: events, isLoading: eventsLoading } = trpc.reports.listEvents.useQuery({ reportId: id }, { enabled: !!report });
  const { data: chatMessages, isLoading: chatLoading } = trpc.reports.getChat.useQuery({ reportId: id }, { enabled: !!report });
  const { data: remarks, isLoading: remarksLoading } = trpc.reports.getRemarks.useQuery({ reportId: id }, { enabled: !!report });
  const chatMutation = trpc.reports.sendChatMessage.useMutation({
    onSuccess: () => {
      // A full window.location.reload() here used to hard-reload the
      // whole page on every message sent — losing the selected tab
      // (Tabs below is uncontrolled, defaultValue="report", so a real
      // reload always snapped back to it), scroll position, and any
      // other in-progress UI state. Invalidating just the chat query
      // refreshes the message list via a normal re-render instead.
      utils.reports.getChat.invalidate({ reportId: id });
    }
  });

  const [chatInput, setChatInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // Jump to the latest message whenever the thread changes (a message
  // just sent, or one pulled in from shore) — otherwise a scrolled-up
  // reader has no signal that a new message landed below the fold.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitMutation = trpc.reports.submitReport.useMutation({
    onSuccess: () => {
      toastManager.add({ title: 'Report submitted', description: 'Finalized and submitted to shore.', type: 'success' });
      utils.reports.getReport.invalidate({ id });
    },
    onSettled: () => {
      setIsSubmitting(false);
    }
  });

  const startCorrectionMutation = trpc.reports.startCorrection.useMutation({
    onSuccess: (newDraft: any) => {
      toastManager.add({ title: 'Correction started', description: `Editing version ${newDraft.versionNo} as a new draft.`, type: 'info' });
      // Same reportId, new versionNo — the URL doesn't change, so
      // invalidate rather than navigate to pick up the new draft.
      utils.reports.getReport.invalidate({ id });
    },
    onError: (err) => {
      toastManager.add({ title: 'Could not start correction', description: err.message, type: 'error' });
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
        <p>Loading report data...</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-status-critical">
        <p>Error loading report: {error?.message || 'Not found'}</p>
        <Link href="/reports">
          <Button variant="link" className="mt-4 text-primary">Return to Reports</Button>
        </Link>
      </div>
    );
  }

  if (report.state === 'draft') {
    return <ReportForm reportId={id} />;
  }

  const handleStartCorrection = () => {
    startCorrectionMutation.mutate({ id });
  };

  const handleSubmit = () => {
    setIsSubmitting(true);
    submitMutation.mutate({ id });
  };

  return (
    <div className="flex flex-col gap-5 max-w-7xl">
      <div className="flex items-center gap-4 border-b border-border pb-6">
        <Link href="/reports">
          <Button variant="ghost" size="icon" aria-label="Back to reports" className="text-muted-foreground hover:text-foreground hover:bg-muted">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Report Details</h1>
            <span className={`px-2.5 py-1 rounded-sm text-xs font-semibold tracking-wide uppercase border ${
              report.state === 'submitted' ? 'bg-status-ok/10 text-status-ok border-status-ok/25' :
              report.state === 'draft' ? 'bg-status-warn/10 text-status-warn border-status-warn/25' :
              report.state === 'remarked' ? 'bg-status-attention/10 text-status-attention border-status-attention/25' :
              report.state === 'invalidated' ? 'bg-status-critical/10 text-status-critical border-status-critical/25' :
              'bg-status-info/10 text-status-info border-status-info/25'
            }`}>
              {report.state}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm font-mono">{report.reportId} • {report.schemaName}</p>
        </div>
        
        {report.state !== 'draft' && (
          <Button
            onClick={handleStartCorrection}
            disabled={startCorrectionMutation.isPending}
            variant="outline"
            className="border-status-warn/30 text-status-warn hover:bg-status-warn/10 hover:text-status-warn h-11 text-base px-5"
          >
            <Pencil className="w-5 h-5 mr-2" />
            {startCorrectionMutation.isPending ? 'Starting...' : 'Start Correction'}
          </Button>
        )}
      </div>

      <Tabs defaultValue="report" className="w-full">
        <div className="scroll-x border-b border-border mb-5">
        <TabsList ref={detailTabsRef} className="bg-transparent w-full justify-start h-auto p-0 gap-0 rounded-none">
          <TabsTrigger value="report" className="relative !flex-none rounded-none border-0 bg-transparent text-muted-foreground px-4 min-h-12 whitespace-nowrap hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-active:after:bg-primary">
            <FileText className="w-4 h-4 mr-2 shrink-0" /> Report Data
          </TabsTrigger>
          <TabsTrigger value="audit" className="relative !flex-none rounded-none border-0 bg-transparent text-muted-foreground px-4 min-h-12 whitespace-nowrap hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-active:after:bg-primary">
            <History className="w-4 h-4 mr-2 shrink-0" /> Audit & History
          </TabsTrigger>
          <TabsTrigger value="chat" className="relative !flex-none rounded-none border-0 bg-transparent text-muted-foreground px-4 min-h-12 whitespace-nowrap hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-active:after:bg-primary">
            <MessageSquare className="w-4 h-4 mr-2 shrink-0" /> Shore Chat
          </TabsTrigger>
          <TabsTrigger value="remarks" className="relative !flex-none rounded-none border-0 bg-transparent text-muted-foreground px-4 min-h-12 whitespace-nowrap hover:bg-surface-hover data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-active:after:bg-primary">
            <Flag className="w-4 h-4 mr-2 shrink-0" /> Remarks
            {remarks && remarks.filter((r: any) => !r.resolved).length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-sm bg-status-attention/15 border border-status-attention/30 text-status-attention text-xs font-semibold">
                {remarks.filter((r: any) => !r.resolved).length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </div>

        <TabsContent value="report" className="mt-0">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2 space-y-6">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Submitted Form Data</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {Object.entries(report.fields as Record<string, unknown>).map(([key, value]) => (
                      <div key={key} className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4 px-4 py-2.5 hover:bg-surface-hover transition-colors">
                        <span className="text-sm text-muted-foreground min-w-0 break-words">{key.replace(/_/g, ' ')}</span>
                        <span className="readout text-sm text-foreground sm:text-right min-w-0 break-words">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
                <CardHeader className="border-b border-border pb-4">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Metadata</CardTitle>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Created By</p>
                    <p className="text-sm text-foreground mt-1">{report.createdBy}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Event Time</p>
                    <p className="text-sm text-foreground mt-1">{new Date(report.eventTime).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Last Modified</p>
                    <p className="text-sm text-foreground mt-1">{new Date(report.updatedAt).toLocaleString()}</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="audit" className="mt-0">
          <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
            <CardHeader className="border-b border-border pb-4">
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Lifecycle Events</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <AuditTimeline events={events as AuditEvent[] | undefined} isLoading={eventsLoading} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chat" className="mt-0">
          <Card className="bg-card border-border overflow-hidden rounded-sm h-[500px] flex flex-col">
            <CardHeader className="border-b border-border pb-4 shrink-0">
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Shore-to-Ship Communication</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 flex flex-col p-4">
              <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-4 mb-4">
                {chatLoading ? (
                  <div className="text-center text-muted-foreground mt-10">Loading messages...</div>
                ) : chatMessages?.length ? (
                  chatMessages.map((msg: any) => (
                    <div key={msg.id} className={`flex flex-col ${msg.direction === 'ship_to_shore' ? 'items-end' : 'items-start'}`}>
                      <div className={`px-3 py-2 rounded-sm max-w-[85%] text-foreground border ${msg.direction === 'ship_to_shore' ? 'bg-surface-active border-primary/30 border-r-2 border-r-primary' : 'bg-muted border-border border-l-2 border-l-border'}`}>
                        <p className="text-sm">{msg.body}</p>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1">{msg.sender} • {new Date(msg.sentAt).toLocaleTimeString()}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-center text-muted-foreground mt-10">
                    <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-50" />
                    <p>No messages yet.</p>
                    <p className="text-xs mt-1">Start a conversation with the shore office.</p>
                  </div>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <input
                  type="text"
                  placeholder="Type a message..."
                  className="flex-1 h-11 bg-card border border-border rounded-sm px-3 text-base text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && chatInput.trim()) {
                      chatMutation.mutate({ reportId: id, body: chatInput });
                      setChatInput('');
                    }
                  }}
                />
                <Button
                  onClick={() => {
                    if (chatInput.trim()) {
                      chatMutation.mutate({ reportId: id, body: chatInput });
                      setChatInput('');
                    }
                  }}
                  disabled={!chatInput.trim() || chatMutation.isPending}
                  className="bg-primary hover:bg-primary/90 h-11 w-11 shrink-0"
                >
                  <Send className="w-5 h-5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="remarks" className="mt-0">
          <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
            <CardHeader className="border-b border-border pb-4">
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Reviewer Remarks</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-4">
                {remarksLoading ? (
                  <div className="text-muted-foreground text-sm">Loading remarks...</div>
                ) : remarks?.length ? (
                  remarks.map((r: any) => (
                    <div key={r.id} className="flex gap-3 items-start p-3 rounded-sm bg-muted border border-border">
                      <Flag className={`w-4 h-4 mt-0.5 shrink-0 ${r.resolved ? 'text-muted-foreground' : 'text-status-attention'}`} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{r.fieldName.replace(/_/g, ' ')}</p>
                          {r.resolved ? (
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Resolved</span>
                          ) : (
                            <span className="text-xs uppercase tracking-wide text-status-attention">Open</span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{r.body}</p>
                        <p className="text-xs text-muted-foreground mt-1.5">{r.author} • {new Date(r.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-muted-foreground text-sm">No remarks on this report.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
