'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { ArrowLeft, CheckCircle2, MessageSquare, Send, Flag, X, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';

import { trpc } from '@/lib/trpc';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { sectionsInOrder, sectionLabel, type SchemaFieldLike } from '@/lib/sections';

export default function ReportDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const utils = trpc.useUtils();
  const { data: report, isLoading, error } = trpc.reports.get.useQuery({ reportId: id });
  const markReviewed = trpc.reports.markReviewed.useMutation({
    onSuccess: () => utils.reports.get.invalidate({ reportId: id }),
  });

  // schemaKind carries the vessel-side ".json" suffix (e.g.
  // "log-abstract.json"); schema_versions.schema_name doesn't.
  const bareSchemaName = report?.schemaKind?.replace(/\.json$/, '');
  const { data: schemaFieldsResult } = trpc.schemas.getFields.useQuery(
    { schemaName: bareSchemaName || '' },
    { enabled: !!bareSchemaName },
  );
  const schemaFieldsByName = new Map<string, SchemaFieldLike>(
    (schemaFieldsResult?.fields ?? []).map((f: SchemaFieldLike) => [f.name, f]),
  );

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
    return <div className="p-8 text-center text-status-critical">Error loading report: {error?.message || 'Not found'}</div>;
  }

  return (
    <div className="flex flex-col gap-4 max-w-7xl">
      <div className="flex items-center text-sm text-muted-foreground mb-4">
        <Link href="/reports" className="hover:text-primary flex items-center transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Ledger
        </Link>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 bg-card p-4 rounded-sm border border-border">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{report.type}</h1>
            <StatusBadge status={report.status} />
          </div>
          <p className="text-muted-foreground mt-1 font-mono text-xs break-all">{report.id}</p>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 mt-3 pt-3 border-t border-border text-sm">
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Vessel</dt>
              <dd className="text-foreground truncate">{report.vessel} ({report.imo})</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Submitted by</dt>
              <dd className="text-foreground truncate">{report.author}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Submitted</dt>
              <dd className="text-foreground font-mono text-xs">{new Date(report.submittedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </div>

        <div className="flex gap-3 w-full lg:w-auto shrink-0">
          {report.reviewed ? (
            <span className="flex items-center gap-2 text-sm text-status-ok px-3 py-2">
              <CheckCircle2 className="w-4 h-4" />
              Reviewed by {report.reviewedBy}
            </span>
          ) : (
            <Button
              onClick={() => markReviewed.mutate({ reportId: id })}
              disabled={markReviewed.isPending}
              className="flex-1 lg:flex-none justify-center"
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {markReviewed.isPending ? 'Marking...' : 'Mark Reviewed'}
            </Button>
          )}
        </div>
      </div>

      {report.status === 'invalidated' && report.brokenRules && report.brokenRules.length > 0 && (
        <div className="flex items-start gap-3 p-4 rounded-sm border border-status-critical/30 bg-status-critical/10">
          <AlertTriangle className="w-5 h-5 text-status-critical shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-status-critical">
              Invalidated by cascade revalidation — a correction to an earlier report broke continuity here.
            </p>
            <p className="text-sm text-status-critical/80 mt-1">Broken rules: {report.brokenRules.join(', ')}</p>
          </div>
        </div>
      )}

          <Card className="bg-card border-border rounded-sm">
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
                  className="bg-status-attention hover:bg-status-attention shrink-0"
                >
                  <Flag className="w-3.5 h-3.5 mr-1.5" />
                  {createRemarkSetMutation.isPending ? 'Sending...' : `Send Remark Set (${Object.keys(pendingRemarks).length})`}
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-6 space-y-8">
              {(() => {
                const fields = report.fields as Record<string, any>;
                const renderField = (key: string, label: string) => (
                  <div key={key} className="border-b border-border/50 pb-3">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {label}
                      </dt>
                      {isReviewer && (
                        <button
                          onClick={() => toggleFlag(key)}
                          className={`shrink-0 p-1 rounded transition-colors ${key in pendingRemarks ? 'text-status-attention bg-status-attention/10' : 'text-muted-foreground hover:text-status-attention hover:bg-status-attention/10'}`}
                          title="Flag this field with a remark"
                        >
                          <Flag className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <dd className="text-foreground font-medium">
                      {fields[key]}
                    </dd>
                    {key in pendingRemarks && (
                      <div className="mt-2 flex items-start gap-2">
                        <textarea
                          value={pendingRemarks[key]}
                          onChange={(e) => setPendingRemarks((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="What's wrong with this field?"
                          rows={2}
                          className="flex-1 bg-background border border-status-attention/30 rounded-md px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-status-attention"
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
                );

                // Groups the payload into the schema's own named sections
                // (Basic/Voyage/Position/Times/...) instead of one flat,
                // undifferentiated grid — a 40+ field schema used to read
                // as a single indistinguishable list. Falls back to a
                // flat list if the schema's field definitions haven't
                // loaded (or the schema is unrecognized), rather than
                // rendering nothing.
                const knownFields = schemaFieldsResult?.fields ?? [];
                const sectionOrder = sectionsInOrder(knownFields);
                if (sectionOrder.length === 0) {
                  return (
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                      {Object.keys(fields).map((key) => renderField(key, key.replace(/_/g, ' ')))}
                    </dl>
                  );
                }

                const matchedKeys = new Set(knownFields.map((f) => f.name));
                const fieldsBySection = new Map<string, { key: string; label: string }[]>();
                for (const f of knownFields) {
                  if (!(f.name in fields)) continue;
                  const arr = fieldsBySection.get(f.section) ?? [];
                  arr.push({ key: f.name, label: f.label || f.name });
                  fieldsBySection.set(f.section, arr);
                }
                const unmatched = Object.keys(fields).filter((k) => !matchedKeys.has(k));

                return (
                  <>
                    {sectionOrder.map((section) => {
                      const entries = fieldsBySection.get(section);
                      if (!entries || entries.length === 0) return null;
                      return (
                        <div key={section}>
                          <h3 className="text-xs font-semibold uppercase tracking-widest text-primary mb-4">
                            {sectionLabel(section)}
                          </h3>
                          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                            {entries.map(({ key, label }) => renderField(key, label))}
                          </dl>
                        </div>
                      );
                    })}
                    {unmatched.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">Other</h3>
                        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                          {unmatched.map((key) => renderField(key, key.replace(/_/g, ' ')))}
                        </dl>
                      </div>
                    )}
                  </>
                );
              })()}
            </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
      <Card className="bg-card border-border rounded-sm h-[420px] flex flex-col">
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
                  <div className={`px-4 py-2 rounded-sm max-w-[80%] ${msg.direction === 'office' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
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

      <Card className="bg-card border-border rounded-sm">
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
                    <Flag className={`w-4 h-4 mt-0.5 shrink-0 ${r.resolved ? 'text-muted-foreground' : 'text-status-attention'}`} />
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
    </div>
  );
}
