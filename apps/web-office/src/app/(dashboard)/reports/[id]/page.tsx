'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, CheckCircle2, Clock, FileText, User, Ship, MessageSquare, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

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

  const { data: chatMessages, isLoading: chatLoading } = trpc.reports.getChat.useQuery({ reportId: id }, { enabled: !!report });
  const [chatInput, setChatInput] = useState('');
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

      <Card className="bg-card/50 border-border h-[420px] flex flex-col">
        <CardHeader className="border-b border-border pb-4 shrink-0">
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-muted-foreground" />
            Vessel Chat
          </CardTitle>
          <CardDescription>Text-only, both directions — same wall the vessel sees under &quot;Shore Chat&quot;.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col pt-4 min-h-0">
          <div className="flex-1 overflow-y-auto space-y-4 mb-4">
            {chatLoading ? (
              <div className="text-center text-muted-foreground mt-10 text-sm">Loading messages...</div>
            ) : chatMessages?.length ? (
              chatMessages.map((msg: any) => (
                <div key={msg.id} className={`flex flex-col ${msg.direction === 'office' ? 'items-end' : 'items-start'}`}>
                  <div className={`px-4 py-2 rounded-xl max-w-[80%] ${msg.direction === 'office' ? 'bg-indigo-600 text-white' : 'bg-muted text-foreground'}`}>
                    <p className="text-sm">{msg.body}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground mt-1">{msg.sender} • {new Date(msg.sentAt).toLocaleTimeString()}</span>
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
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
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
              className="bg-indigo-600 hover:bg-indigo-500"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
