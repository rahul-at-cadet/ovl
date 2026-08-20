'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, CheckCircle2, Clock, FileText, User, Ship, MessageSquare, Send, Flag, X, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';

import { trpc } from '@/lib/trpc';
import { useCurrentUser } from '@/lib/useCurrentUser';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  remarked: 'Remarked',
  invalidated: 'Invalidated',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-zinc-500/10 text-muted-foreground border-zinc-500/20',
  submitted: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  remarked: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  invalidated: 'bg-red-500/10 text-red-400 border-red-500/20',
};

export default function ReportDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const utils = trpc.useUtils();
  const { data: report, isLoading, error } = trpc.reports.get.useQuery({ reportId: id });
  const markReviewed = trpc.reports.markReviewed.useMutation({
    onSuccess: () => utils.reports.get.invalidate({ reportId: id }),
  });

  const { data: chatMessages, isLoading: chatLoading } = trpc.reports.getChat.useQuery({ reportId: id }, { enabled: !!report });
  const [chatInput, setChatInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // Jump to the latest message whenever the thread changes — same fix
  // as the vessel app's own report detail chat, otherwise a scrolled-up
  // reader has no signal a new message landed below the fold.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);
  const chatMutation = trpc.reports.sendChatMessage.useMutation({
    onSuccess: () => {
      setChatInput('');
      utils.reports.getChat.invalidate({ reportId: id });
    },
  });
  const sendChat = () => {
    if (!chatInput.trim() || chatMutation.isPending) return;
    chatMutation.mutate({ reportId: id, body: chatInput });
  };

  const { data: currentUser } = useCurrentUser();
  const isReviewer = !!currentUser?.roles?.includes('reviewer');

  const { data: remarks } = trpc.reports.listRemarks.useQuery({ reportId: id }, { enabled: !!report });
  const [pendingRemarks, setPendingRemarks] = useState<Record<string, string>>({});
  const createRemarkSetMutation = trpc.reports.createRemarkSet.useMutation({
    onSuccess: () => {
      setPendingRemarks({});
      utils.reports.listRemarks.invalidate({ reportId: id });
      utils.reports.getChat.invalidate({ reportId: id });
      utils.reports.get.invalidate({ reportId: id });
    },
  });
  const setRemarkResolvedMutation = trpc.reports.setRemarkResolved.useMutation({
    onSuccess: () => utils.reports.listRemarks.invalidate({ reportId: id }),
  });

  const toggleFlag = (fieldName: string) => {
    setPendingRemarks((prev) => {
      const next = { ...prev };
      if (fieldName in next) delete next[fieldName];
      else next[fieldName] = '';
      return next;
    });
  };
  const sendRemarkSet = () => {
    const entries = Object.entries(pendingRemarks).filter(([, body]) => body.trim());
    if (entries.length === 0 || createRemarkSetMutation.isPending) return;
    createRemarkSetMutation.mutate({
      reportId: id,
      remarks: entries.map(([fieldName, body]) => ({ fieldName, body })),
    });
  };

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading report details...</div>;
  }

  if (error || !report) {
    return <div className="p-8 text-center text-red-400">Error loading report: {error?.message || 'Not found'}</div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      <div className="flex items-center text-sm text-muted-foreground mb-4">
        <Link href="/reports" className="hover:text-primary flex items-center transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Ledger
        </Link>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card/50 p-6 rounded-xl border border-border shadow-lg backdrop-blur-sm">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-muted rounded-lg border border-border">
            <FileText className="w-8 h-8 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{report.type}</h1>
              <Badge variant="outline" className={`${STATUS_CLASS[report.status] ?? 'bg-orange-500/10 text-orange-400 border-orange-500/20'} uppercase tracking-widest text-xs`}>
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

      {report.status === 'invalidated' && report.brokenRules && report.brokenRules.length > 0 && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/10">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-400">
              Invalidated by cascade revalidation — a correction to an earlier report broke continuity here.
            </p>
            <p className="text-sm text-red-400/80 mt-1">Broken rules: {report.brokenRules.join(', ')}</p>
          </div>
        </div>
      )}

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
            <CardHeader className="border-b border-border pb-4 flex flex-row items-center justify-between">
              <div>
                <CardTitle>Report Payload</CardTitle>
                <CardDescription>Read-only view of the data submitted from the edge.</CardDescription>
              </div>
              {isReviewer && Object.keys(pendingRemarks).length > 0 && (
                <Button
                  onClick={sendRemarkSet}
                  disabled={createRemarkSetMutation.isPending || Object.values(pendingRemarks).every((b) => !b.trim())}
                  size="sm"
                  className="bg-orange-600 hover:bg-orange-500 shrink-0"
                >
                  <Flag className="w-3.5 h-3.5 mr-1.5" />
                  {createRemarkSetMutation.isPending ? 'Sending...' : `Send Remark Set (${Object.keys(pendingRemarks).length})`}
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-6">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-8">
                {Object.entries(report.fields).map(([key, value]) => (
                  <div key={key} className="border-b border-border/50 pb-3">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {key.replace(/_/g, ' ')}
                      </dt>
                      {isReviewer && (
                        <button
                          onClick={() => toggleFlag(key)}
                          className={`shrink-0 p-1 rounded transition-colors ${key in pendingRemarks ? 'text-orange-400 bg-orange-500/10' : 'text-muted-foreground hover:text-orange-400 hover:bg-orange-500/10'}`}
                          title="Flag this field with a remark"
                        >
                          <Flag className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <dd className="text-foreground font-medium">
                      {value}
                    </dd>
                    {key in pendingRemarks && (
                      <div className="mt-2 flex items-start gap-2">
                        <textarea
                          value={pendingRemarks[key]}
                          onChange={(e) => setPendingRemarks((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="What's wrong with this field?"
                          rows={2}
                          className="flex-1 bg-background border border-orange-500/30 rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-orange-500"
                        />
                        <button
                          onClick={() => toggleFlag(key)}
                          className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
                          title="Unflag"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="bg-card/50 border-border h-[420px] flex flex-col">
        <CardHeader className="border-b border-border pb-4 shrink-0">
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-muted-foreground" />
            Vessel Chat
          </CardTitle>
          <CardDescription>Text-only, both directions — same wall the vessel sees under &quot;Shore Chat&quot;.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col pt-4 min-h-0">
          <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-4 mb-4">
            {chatLoading ? (
              <div className="text-center text-muted-foreground mt-10 text-sm">Loading messages...</div>
            ) : chatMessages?.length ? (
              chatMessages.map((msg: any) => (
                <div key={msg.id} className={`flex flex-col ${msg.direction === 'office' ? 'items-end' : 'items-start'}`}>
                  <div className={`px-4 py-2 rounded-xl max-w-[80%] ${msg.direction === 'office' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
                    <p className="text-sm">{msg.body}</p>
                  </div>
                  <span className="text-xs text-muted-foreground mt-1">{msg.sender} • {new Date(msg.sentAt).toLocaleTimeString()}</span>
                </div>
              ))
            ) : (
              <div className="text-center text-muted-foreground mt-10">
                <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No messages yet.</p>
                <p className="text-xs mt-1">Start a conversation with the vessel.</p>
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <input
              type="text"
              placeholder="Type a message..."
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendChat();
              }}
            />
            <Button
              onClick={sendChat}
              disabled={!chatInput.trim() || chatMutation.isPending}
              size="sm"
              className="bg-primary hover:bg-primary/90"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/50 border-border">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <Flag className="w-4 h-4 text-muted-foreground" />
            Remarks
          </CardTitle>
          <CardDescription>Fields flagged by a Reviewer, oldest first.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="space-y-3">
            {remarks?.length ? (
              remarks.map((r: any) => (
                <div key={r.id} className="flex items-start justify-between gap-3 p-3 rounded-lg bg-background/50 border border-border/60">
                  <div className="flex gap-3">
                    <Flag className={`w-4 h-4 mt-0.5 shrink-0 ${r.resolved ? 'text-muted-foreground' : 'text-orange-400'}`} />
                    <div>
                      <p className="text-sm font-medium text-foreground">{r.fieldName.replace(/_/g, ' ')}</p>
                      <p className="text-sm text-muted-foreground mt-1">{r.body}</p>
                      <p className="text-xs text-muted-foreground mt-1.5">{r.author} • {new Date(r.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                  {isReviewer && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemarkResolvedMutation.mutate({ id: r.id, resolved: !r.resolved })}
                      disabled={setRemarkResolvedMutation.isPending}
                      className="shrink-0"
                    >
                      {r.resolved ? 'Reopen' : 'Resolve'}
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No remarks on this report yet.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
