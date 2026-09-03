'use client';

import { useRef, useState } from 'react';
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
import { Upload, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useToastManager } from '@ovl/ui/components/toast';

/**
 * Manual restore-bundle import — ports design handoff A10's DR section
 * (ovl/vessel/httpapi's handleImportRestoreBundle).
 *
 * The automatic path is the normal one: office pushes a restore, this
 * node collects and applies it on its next sync with nobody touching
 * anything. This screen exists for the node that cannot sync at all —
 * someone carries the file aboard, and the Master imports it here.
 *
 * Master-only, and confirm-gated, because importing writes straight into
 * the report store: anything held locally at the same report version is
 * replaced by the bundle's copy.
 */

/** Rough guard against picking the wrong file entirely. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export function RecoveryTab() {
  const toastManager = useToastManager();
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: status, isLoading } = trpc.system.restoreStatus.useQuery();
  const [pending, setPending] = useState<{ name: string; base64: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<{
    vesselName: string;
    generatedAt: string;
    reports: number;
    versions: number;
    events: number;
    chatMessages: number;
    configBundleApplied: boolean;
  } | null>(null);

  const importMutation = trpc.system.importRestoreBundle.useMutation({
    onSuccess: (imported) => {
      setPending(null);
      setResult(imported);
      toastManager.add({ title: 'Restore bundle applied', type: 'success' });
    },
    onError: (err) => {
      setPending(null);
      toastManager.add({ title: 'Restore bundle rejected', description: err.message, type: 'error' });
    },
  });

  const chooseFile = async (file: File | undefined) => {
    // Reset the input either way, so picking the same file twice after a
    // failure still fires a change event.
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) {
      toastManager.add({
        title: 'That file is too large to be a restore bundle',
        description: 'Check you picked the .age bundle office generated, not a full database backup.',
        type: 'error',
      });
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Chunked rather than one spread call: a bundle is comfortably
      // large enough to blow the argument limit on String.fromCharCode.
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      setResult(null);
      setPending({ name: file.name, base64: btoa(binary) });
    } catch (err: any) {
      toastManager.add({ title: 'Could not read that file', description: err.message, type: 'error' });
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <Card className="bg-card border-border overflow-hidden rounded-sm shadow-none">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Restore From Office</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Rebuild this node from a bundle the office generated for it — every report version it holds, the audit
            trail, chat and the assigned config. Attachments are not included.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Checking this node&apos;s restore key…</p>
          ) : status?.hasRestoreKey ? (
            <p className="text-xs text-muted-foreground">
              This node holds its own restore key, and office holds only the public half — so a bundle built for this
              vessel can be opened by nothing else, not even by the office that produced it. Office normally pushes a
              restore and this node collects it automatically on its next sync; use the import below only when this
              node cannot reach shore at all.
            </p>
          ) : (
            <div className="flex gap-3 rounded-sm border border-status-warn/25 bg-status-warn/10 p-3">
              <ShieldAlert className="mt-0.5 w-4 h-4 shrink-0 text-status-warn" />
              <div>
                <p className="text-xs font-semibold text-status-warn">This node has no restore key</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The key is generated here when the node redeems an enrollment code. Ask the office for a fresh code
                  and redeem it on the setup screen — until then there is nothing a restore bundle could be encrypted
                  to.
                </p>
              </div>
            </div>
          )}

          {result ? (
            <div className="flex gap-3 rounded-sm border border-status-ok/25 bg-status-ok/10 p-3">
              <CheckCircle2 className="mt-0.5 w-4 h-4 shrink-0 text-status-ok" />
              <div className="text-xs text-foreground">
                <p className="font-semibold">Restored {result.vesselName}</p>
                <p className="mt-1 text-muted-foreground">
                  {result.reports} report{result.reports === 1 ? '' : 's'} · {result.versions} version
                  {result.versions === 1 ? '' : 's'} · {result.events} new audit event
                  {result.events === 1 ? '' : 's'} · {result.chatMessages} chat message
                  {result.chatMessages === 1 ? '' : 's'}
                  {result.configBundleApplied ? ' · config bundle applied' : ' · no config bundle in this bundle'}.
                </p>
              </div>
            </div>
          ) : null}

          <input
            ref={fileRef}
            type="file"
            accept=".age,application/octet-stream"
            className="hidden"
            onChange={(e) => chooseFile(e.target.files?.[0])}
          />
          <Button
            variant="outline"
            className="border-border bg-background hover:bg-card text-foreground"
            disabled={!status?.hasRestoreKey || reading || importMutation.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="w-4 h-4 mr-2" />
            {reading ? 'Reading file…' : 'Import restore bundle'}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import this restore bundle?</DialogTitle>
            <DialogDescription>
              This rebuilds the node from what the office holds. Any local report sitting at the same version — a draft
              that has not been submitted included — is replaced by the bundle&apos;s copy. There is no undo.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            File: <span className="font-mono text-foreground">{pending?.name}</span>
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={importMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                pending && importMutation.mutate({ ciphertextBase64: pending.base64, confirm: true })
              }
              disabled={importMutation.isPending}
            >
              {importMutation.isPending ? 'Importing…' : 'Import and overwrite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
