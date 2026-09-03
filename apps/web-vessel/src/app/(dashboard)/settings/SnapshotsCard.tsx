'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ovl/ui/components/dialog';
import { Camera, History, RotateCcw, Trash2, Paperclip } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useToastManager } from '@ovl/ui/components/toast';

/**
 * Local snapshots — ports design handoff A10's Backup section.
 *
 * The office restore bundle rebuilds a node from what *shore* holds. It
 * cannot carry drafts, locally captured attachments, or anything not yet
 * synced, so those exist nowhere but this vessel. A snapshot taken here
 * is the only thing that brings them back, which is why this sits next to
 * the office restore rather than buried under storage settings.
 */

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function SnapshotsCard() {
  const toastManager = useToastManager();
  const utils = trpc.useUtils();
  const { data: snapshots = [], isLoading } = trpc.system.listBackups.useQuery();

  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const refresh = () => utils.system.listBackups.invalidate();

  const snapshot = trpc.system.snapshotNow.useMutation({
    onSuccess: (info) => {
      toastManager.add({ title: 'Snapshot taken', description: `Saved as ${info.id}.`, type: 'success' });
      refresh();
    },
    onError: (e) => toastManager.add({ title: 'Snapshot failed', description: e.message, type: 'error' }),
  });

  const restore = trpc.system.restoreBackup.useMutation({
    onSuccess: () => {
      setRestoreTarget(null);
      toastManager.add({
        title: 'Node restored',
        description: 'The state you replaced was kept as its own snapshot.',
        type: 'success',
      });
      // Everything on screen came from the database that was just
      // swapped, so nothing cached is still true.
      utils.invalidate();
    },
    onError: (e) => {
      setRestoreTarget(null);
      toastManager.add({ title: 'Restore failed', description: e.message, type: 'error' });
    },
  });

  const remove = trpc.system.deleteBackup.useMutation({
    onSuccess: () => {
      setDeleteTarget(null);
      refresh();
    },
    onError: (e) => {
      setDeleteTarget(null);
      toastManager.add({ title: 'Could not delete snapshot', description: e.message, type: 'error' });
    },
  });

  const busy = snapshot.isPending || restore.isPending;

  return (
    <>
      <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
        <CardHeader className="border-b border-border pb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Local Snapshots</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-1">
              A point-in-time copy of this node&apos;s database and attachments. One is taken automatically each
              night.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            className="w-full xl:w-auto justify-center shrink-0"
            disabled={busy}
            onClick={() => snapshot.mutate()}
          >
            <Camera className="w-4 h-4 mr-2" />
            {snapshot.isPending ? 'Taking snapshot…' : 'Snapshot now'}
          </Button>
        </CardHeader>
        <CardContent className="pt-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading snapshots…</p>
          ) : snapshots.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <History className="w-7 h-7 text-muted-foreground opacity-50" />
              <p className="text-sm text-muted-foreground">
                No snapshots yet. One will be taken tonight, or take one now.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border rounded-sm border border-border">
              {snapshots.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {new Date(s.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{s.id}</span>
                      <span>·</span>
                      <span className="tabular-nums">{formatBytes(s.sizeBytes)}</span>
                      {s.hasAttachments ? (
                        <span className="inline-flex items-center gap-1">
                          <Paperclip className="w-3 h-3" /> attachments
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setRestoreTarget(s.id)}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete snapshot ${s.id}`}
                      disabled={busy}
                      onClick={() => setDeleteTarget(s.id)}
                      className="text-muted-foreground hover:text-status-critical"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={restoreTarget !== null} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this node to that snapshot?</DialogTitle>
            <DialogDescription>
              Every report, draft and attachment on this vessel is replaced with the state at that moment. Anything
              recorded since — including work not yet synced to the office — is rolled back.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The state you are replacing is kept as its own snapshot, so this can be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)} disabled={restore.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => restoreTarget && restore.mutate({ id: restoreTarget, confirm: true })}
              disabled={restore.isPending}
            >
              {restore.isPending ? 'Restoring…' : 'Restore node'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this snapshot?</DialogTitle>
            <DialogDescription>
              It is removed from this node permanently. Other snapshots are unaffected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => deleteTarget && remove.mutate({ id: deleteTarget })}
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
