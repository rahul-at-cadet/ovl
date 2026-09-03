'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Badge } from '@ovl/ui/components/badge';
import { Paperclip, Download, Clock, FileImage, FileText } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { API_ORIGIN } from '@/lib/api-origin';

/**
 * Evidence a report cites, as held ashore — ports design handoff B4's
 * attachments panel.
 *
 * Until attachment sync landed there was nothing to show here: vessels
 * captured delivery notes and photos and none of it ever left the ship.
 */

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return kb >= 1 ? `${Math.round(kb)} KB` : `${bytes} B`;
}

export function Attachments({ reportId, vesselId }: { reportId: string; vesselId: string }) {
  const { data: attachments = [], isLoading } = trpc.reports.listAttachments.useQuery({ vesselId, reportId });

  return (
    <Card className="bg-card border-border rounded-md">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4 text-muted-foreground" />
          Attachments
          {attachments.length > 0 ? (
            <span className="text-sm font-normal tabular-nums text-muted-foreground">{attachments.length}</span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Supporting files the vessel captured for this report, as held ashore.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading attachments…</p>
        ) : attachments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This report cites no attachments.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {attachments.map((a) => {
              const Icon = a.contentType?.startsWith('image/') ? FileImage : FileText;
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{a.filename}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">{formatBytes(a.sizeBytes)}</span>
                      {a.fieldName ? <span> · {a.fieldName}</span> : null}
                      <span> · v{a.versionNo}</span>
                    </p>
                  </div>
                  {a.available ? (
                    /* A plain link, not a fetch: the file streams from the
                       office origin with its own Content-Disposition, so
                       the browser saves it without the whole attachment
                       passing through JavaScript. */
                    <a
                      href={`${API_ORIGIN}/attachments/${vesselId}/${reportId}/${a.id}`}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <Download className="size-3.5" />
                      Download
                    </a>
                  ) : (
                    /* The row exists before the bytes do — the association
                       is recorded when the vessel first declares the file,
                       and the transfer may still be running or have been
                       interrupted. Saying so beats a download that fails. */
                    <Badge variant="outline" className="shrink-0 border-status-warn/30 bg-status-warn/10 text-status-warn">
                      <Clock className="mr-1.5 size-3" />
                      Awaiting transfer
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
