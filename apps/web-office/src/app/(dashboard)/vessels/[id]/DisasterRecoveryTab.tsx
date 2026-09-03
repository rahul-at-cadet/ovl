'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Badge } from '@ovl/ui/components/badge';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ovl/ui/components/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ovl/ui/components/dialog';
import { Download, Send, ShieldAlert, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';

/**
 * Disaster recovery — ports design handoff B2's DR tab
 * (ovl/office/httpapi's generate/push restore-bundle handlers).
 *
 * Two routes to the same bytes. Download hands an admin an encrypted
 * file to carry aboard a vessel that cannot be reached; push queues a
 * command the vessel collects itself on its next sync. Which to use is a
 * question of whether the ship is reachable, so both are offered side by
 * side rather than one being buried.
 *
 * Every bundle is encrypted to the vessel's own public key, which only
 * exists once that vessel has redeemed an enrollment code. Without one
 * there is nothing to encrypt against, so the actions are disabled and
 * say why — the fix (issue a fresh code) is on the Enrollment tab.
 */

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * Where a queued restore has actually got to. The push endpoint only
 * confirms the command was queued, so these three states are the whole
 * answer to "has it landed" — an admin watching a vessel come back needs
 * to tell "not collected yet" from "collected but failed to apply".
 */
function commandStatus(command: { fetchedAt: string | null; appliedAt: string | null }) {
  if (command.appliedAt) {
    return { label: 'Applied', icon: CheckCircle2, className: 'border-status-ok/30 bg-status-ok/10 text-status-ok' };
  }
  if (command.fetchedAt) {
    return {
      label: 'Collected, applying',
      icon: AlertTriangle,
      className: 'border-status-warn/30 bg-status-warn/10 text-status-warn',
    };
  }
  return { label: 'Waiting for vessel', icon: Clock, className: 'border-border bg-muted text-muted-foreground' };
}

export function DisasterRecoveryTab({ vesselId, vesselName }: { vesselId: string; vesselName: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.vessels.restoreCommands.useQuery({ vesselId });

  const [pushOpen, setPushOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const generate = trpc.vessels.generateRestoreBundle.useMutation({
    onSuccess: (result) => {
      // The bundle never becomes a string in the DOM — it is decoded
      // straight into a Blob and handed to the browser as a file. It is
      // one vessel's entire reporting history, and an encrypted one at
      // that, so there is nothing useful to show on screen.
      const bytes = Uint8Array.from(atob(result.ciphertextBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setFailure(null);
      setNotice(
        `Downloaded ${result.filename} — ${result.reportCount} report${result.reportCount === 1 ? '' : 's'}, ` +
          `${result.versionCount} version${result.versionCount === 1 ? '' : 's'}` +
          `${result.configBundleIncluded ? ', including the assigned config bundle' : ', with no config bundle assigned'}.`,
      );
    },
    onError: (err) => {
      setNotice(null);
      setFailure(err.message);
    },
  });

  const push = trpc.vessels.pushRestoreBundle.useMutation({
    onSuccess: () => {
      setPushOpen(false);
      setReason('');
      setFailure(null);
      setNotice(`Restore queued for ${vesselName}. It will be collected on the vessel's next sync.`);
      utils.vessels.restoreCommands.invalidate({ vesselId });
    },
    onError: (err) => {
      setPushOpen(false);
      setNotice(null);
      setFailure(err.message);
    },
  });

  const hasKey = data?.hasRestoreKey ?? false;
  const commands = data?.commands ?? [];
  const busy = generate.isPending || push.isPending;

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-semibold tracking-tight">Disaster Recovery</CardTitle>
          <CardDescription className="text-xs">
            Rebuild a vessel that has lost its local data from everything shore holds for it — every report version,
            its audit trail, chat, and the config bundle assigned to it. Attachments are not included.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading recovery status…</p>
          ) : !hasKey ? (
            <div className="flex gap-3 rounded-md border border-status-warn/25 bg-status-warn/10 p-3">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-warn" />
              <div>
                <p className="text-xs font-semibold text-status-warn">This vessel cannot receive a restore yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  A restore bundle is encrypted to a key the vessel generates for itself when it redeems an enrollment
                  code, so office can never read one. This vessel has no key on file — issue it a fresh code from the
                  Enrollment tab and redeem it aboard.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Bundles are encrypted to this vessel&apos;s own key and can be opened by nothing else — not even by this
              office. Each one is built fresh at the moment it is collected, so it always carries everything shore holds
              right now.
            </p>
          )}

          {notice ? (
            <div className="rounded-md border border-status-ok/25 bg-status-ok/10 p-3 text-xs text-foreground">
              {notice}
            </div>
          ) : null}
          {failure ? (
            <div className="rounded-md border border-status-critical/25 bg-status-critical/10 p-3 text-xs text-foreground">
              {failure}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!hasKey || busy}
              onClick={() => generate.mutate({ vesselId })}
            >
              <Download className="mr-2 size-4" />
              {generate.isPending ? 'Building bundle…' : 'Download bundle'}
            </Button>
            <Button disabled={!hasKey || busy} onClick={() => setPushOpen(true)}>
              <Send className="mr-2 size-4" />
              Push to vessel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Download for a vessel you can reach in person; push for one that is still syncing.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-semibold tracking-tight">Push History</CardTitle>
          <CardDescription className="text-xs">
            Restores queued for this vessel, and how far each one has got.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          {isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : commands.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No restore has ever been pushed to this vessel.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  {/* Status leads: "has it landed" is the only question
                      this table is here to answer. Five columns pushed it
                      past the panel and hid exactly that one behind a
                      horizontal scroll, so the collected/applied time now
                      sits under the badge it belongs to rather than in a
                      column of its own. */}
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Issued by</TableHead>
                  <TableHead>Issued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Newest first: the row an admin came here to check is
                    the one they just queued. */}
                {[...commands].reverse().map((command) => {
                  const status = commandStatus(command);
                  const StatusIcon = status.icon;
                  const landmark = command.appliedAt ?? command.fetchedAt;
                  return (
                    <TableRow key={command.id} className="border-border">
                      <TableCell className="align-top">
                        <Badge variant="outline" className={status.className}>
                          <StatusIcon className="mr-1.5 size-3" />
                          {status.label}
                        </Badge>
                        {landmark ? (
                          <span className="mt-1 block text-xs text-muted-foreground">{formatTime(landmark)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top text-foreground">{command.reason}</TableCell>
                      {/* Usernames are email addresses, so this column
                          has no natural width — an unbounded one pushed
                          the table past the panel on its own. Bounded and
                          truncated, with the full address on hover. */}
                      <TableCell
                        className="max-w-[14rem] truncate align-top text-muted-foreground"
                        title={command.issuedBy}
                      >
                        {command.issuedBy}
                      </TableCell>
                      <TableCell className="align-top whitespace-nowrap text-muted-foreground">
                        {formatTime(command.issuedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={pushOpen} onOpenChange={setPushOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Push a restore to {vesselName}?</DialogTitle>
            <DialogDescription>
              The vessel collects this on its next sync and rebuilds itself from it. Anything it holds locally at the
              same report version is overwritten, so this is for a node that has lost its data — not a way to nudge one
              that is merely behind.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="restore-reason">Reason (optional)</Label>
            <Input
              id="restore-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. node rebuilt after disk failure"
            />
            <p className="text-xs text-muted-foreground">
              Recorded against the push so the history explains itself later.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPushOpen(false)} disabled={push.isPending}>
              Cancel
            </Button>
            <Button onClick={() => push.mutate({ vesselId, reason: reason.trim() || undefined })} disabled={push.isPending}>
              {push.isPending ? 'Queueing…' : 'Push restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
