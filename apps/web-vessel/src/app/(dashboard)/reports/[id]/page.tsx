'use client';

import { useParams, useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft, Send, MessageSquare, History, FileText, Pencil, Flag } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Link from 'next/link';
import { useState } from 'react';
import { ReportForm } from '@/components/ReportForm';
import { useToastManager } from '@/components/ui/toast';

export default function ReportDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const toastManager = useToastManager();
  const utils = trpc.useUtils();

  const { data: report, isLoading, error } = trpc.reports.getReport.useQuery({ id });
  const { data: events, isLoading: eventsLoading } = trpc.reports.listEvents.useQuery({ reportId: id }, { enabled: !!report });
  const { data: chatMessages, isLoading: chatLoading } = trpc.reports.getChat.useQuery({ reportId: id }, { enabled: !!report });
  const { data: remarks, isLoading: remarksLoading } = trpc.reports.getRemarks.useQuery({ reportId: id }, { enabled: !!report });
  const chatMutation = trpc.reports.sendChatMessage.useMutation({
    onSuccess: () => {
      // Refresh chat messages
      window.location.reload();
    }
  });

  const [chatInput, setChatInput] = useState('');
  
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
      <div className="flex flex-col items-center justify-center h-64 text-red-400">
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
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 border-b border-border/60 pb-6">
        <Link href="/reports">
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground hover:bg-muted">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Report Details</h1>
            <span className={`px-2.5 py-1 rounded-md text-xs font-semibold tracking-wide uppercase border ${
              report.state === 'submitted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
              report.state === 'draft' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
              report.state === 'remarked' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' :
              report.state === 'invalidated' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
              'bg-blue-500/10 text-blue-400 border-blue-500/20'
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
            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300 h-11 text-base px-5"
          >
            <Pencil className="w-5 h-5 mr-2" />
            {startCorrectionMutation.isPending ? 'Starting...' : 'Start Correction'}
          </Button>
        )}
      </div>

      <Tabs defaultValue="report" className="w-full">
        <TabsList className="bg-background/50 border border-border w-full md:w-auto grid grid-cols-4 md:flex p-1 mb-6">
          <TabsTrigger value="report" className="data-[state=active]:bg-muted data-[state=active]:text-foreground">
            <FileText className="w-4 h-4 mr-2 hidden sm:inline" /> Report Data
          </TabsTrigger>
          <TabsTrigger value="audit" className="data-[state=active]:bg-muted data-[state=active]:text-foreground">
            <History className="w-4 h-4 mr-2 hidden sm:inline" /> Audit & History
          </TabsTrigger>
          <TabsTrigger value="chat" className="data-[state=active]:bg-muted data-[state=active]:text-foreground">
            <MessageSquare className="w-4 h-4 mr-2 hidden sm:inline" /> Shore Chat
          </TabsTrigger>
          <TabsTrigger value="remarks" className="data-[state=active]:bg-muted data-[state=active]:text-foreground">
            <Flag className="w-4 h-4 mr-2 hidden sm:inline" /> Remarks
            {remarks && remarks.filter((r: any) => !r.resolved).length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-semibold">
                {remarks.filter((r: any) => !r.resolved).length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="report" className="mt-0">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2 space-y-6">
              <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Submitted Form Data</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-zinc-800/50">
                    {Object.entries(report.fields as Record<string, unknown>).map(([key, value]) => (
                      <div key={key} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 hover:bg-muted/20 transition-colors">
                        <span className="text-sm font-medium text-muted-foreground">{key.replace(/_/g, ' ')}</span>
                        <span className="text-sm text-foreground mt-1 sm:mt-0 font-medium">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
                <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
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
          <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
            <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Lifecycle Events</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-4">
                {eventsLoading ? (
                  <div className="text-muted-foreground text-sm">Loading events...</div>
                ) : events?.length ? (
                  events.map((event: any) => (
                    <div key={event.id} className="flex gap-4 items-start">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${event.type === 'submitted' ? 'bg-emerald-500' : 'bg-blue-500'}`} />
                      <div>
                        <p className="text-sm text-foreground font-medium capitalize">{event.type.replace('_', ' ')}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{new Date(event.at).toLocaleString()} by {event.actor}</p>
                        {event.detail && Object.keys(event.detail).length > 0 && (
                          <div className="mt-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded">
                            {JSON.stringify(event.detail)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-muted-foreground text-sm">No events found.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chat" className="mt-0">
          <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md h-[500px] flex flex-col">
            <CardHeader className="border-b border-border/60 pb-4 bg-card/20 shrink-0">
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Shore-to-Ship Communication</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col p-4">
              <div className="flex-1 overflow-y-auto space-y-4 mb-4">
                {chatLoading ? (
                  <div className="text-center text-muted-foreground mt-10">Loading messages...</div>
                ) : chatMessages?.length ? (
                  chatMessages.map((msg: any) => (
                    <div key={msg.id} className={`flex flex-col ${msg.direction === 'ship_to_shore' ? 'items-end' : 'items-start'}`}>
                      <div className={`px-4 py-2 rounded-xl max-w-[80%] ${msg.direction === 'ship_to_shore' ? 'bg-primary text-white' : 'bg-muted text-foreground'}`}>
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
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Type a message..."
                  className="flex-1 h-11 bg-card border border-border rounded-lg px-3 text-base text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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
          <Card className="bg-card/40 border-border/60 shadow-xl overflow-hidden rounded-xl backdrop-blur-md">
            <CardHeader className="border-b border-border/60 pb-4 bg-card/20">
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Reviewer Remarks</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-4">
                {remarksLoading ? (
                  <div className="text-muted-foreground text-sm">Loading remarks...</div>
                ) : remarks?.length ? (
                  remarks.map((r: any) => (
                    <div key={r.id} className="flex gap-3 items-start p-3 rounded-lg bg-muted/20 border border-border/40">
                      <Flag className={`w-4 h-4 mt-0.5 shrink-0 ${r.resolved ? 'text-muted-foreground' : 'text-orange-400'}`} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{r.fieldName.replace(/_/g, ' ')}</p>
                          {r.resolved ? (
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Resolved</span>
                          ) : (
                            <span className="text-xs uppercase tracking-wide text-orange-400">Open</span>
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
