'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Badge } from '@ovl/ui/components/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ovl/ui/components/dialog';
import {
  ArrowLeft,
  Ship,
  Ticket,
  Settings2,
  Users,
  Wifi,
  WifiOff,
  Copy,
  CheckCircle2,
  KeyRound,
  LifeBuoy,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { VesselUsersDialog } from '../VesselUsersDialog';
import { DisasterRecoveryTab } from './DisasterRecoveryTab';

/**
 * Vessel detail — ports design handoff B2's vessel detail screen
 * (ovl/web/office/src/screens/vessels/VesselDetailScreen.tsx), which the
 * port had no equivalent of: the vessel list's row menu was the only way
 * to act on a vessel, and nothing anywhere showed enrollment state, the
 * resolved config bundle, or what a vessel actually reports about itself.
 *
 * The DR tab is admin-only, unlike the rest of this screen: its
 * procedures return and queue one vessel's entire reporting history, so
 * showing a disabled tab to a viewer would only advertise an action they
 * cannot take.
 */

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'Never';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Small labelled value, used throughout the profile and config panels. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export default function VesselDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const vesselId = params.id;

  const { data: currentUser } = useCurrentUser();
  const isAdmin = (currentUser?.roles ?? []).includes('admin');

  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.vessels.get.useQuery({ id: vesselId });

  const [usersOpen, setUsersOpen] = useState(false);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issueMutation = trpc.vessels.issueEnrollment.useMutation({
    onSuccess: (result) => {
      setIssuedCode(result.code);
      setConfirmIssue(false);
      utils.vessels.get.invalidate({ id: vesselId });
    },
  });
  const revokeMutation = trpc.vessels.revokeEnrollment.useMutation({
    onSuccess: () => utils.vessels.get.invalidate({ id: vesselId }),
  });

  // Matches Settings' own copy helper: navigator.clipboard is undefined
  // outside a secure context, which this deployment commonly is.
  const copyCode = (text: string) => {
    const viaFallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(viaFallback);
    else viaFallback();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading vessel…</div>;
  }

  if (error || !data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted-foreground">{error?.message ?? 'Vessel not found.'}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/vessels')}>
          Back to Fleet
        </Button>
      </div>
    );
  }

  const { vessel, sync, enrollment, credential, bundle, users, userCommands } = data;
  const online = sync.edgeStatus === 'Online';

  // Shore is authoritative on identity, but what the node reports about
  // itself is worth showing when the two differ — that gap is the signal
  // that a vessel has not synced since a rename.
  const identityDrift =
    (sync.reportedName && sync.reportedName !== vessel.name) ||
    (sync.reportedImo && sync.reportedImo !== vessel.imo);

  return (
    <div className="h-[calc(100dvh-96px)] lg:h-[calc(100dvh-112px)] flex flex-col space-y-6 overflow-hidden">
      <div className="shrink-0 border-b border-border pb-6">
        <Link
          href="/vessels"
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Fleet Management
        </Link>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">{vessel.name}</h1>
            <p className="mt-1.5 text-sm font-medium text-muted-foreground">
              <span className="tabular-nums">IMO {vessel.imo}</span>
              {vessel.type ? <span> · {vessel.type}</span> : null}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {online ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-status-ok">
                <Wifi className="size-4" /> Online
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-status-critical">
                <WifiOff className="size-4" /> Offline
              </span>
            )}
            <span className="text-xs text-muted-foreground">· last sync {relativeTime(sync.lastSeenAt)}</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="profile" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-full justify-start shrink-0 bg-transparent gap-2">
          <TabsTrigger value="profile" className="data-[state=active]:bg-muted">
            <Ship className="mr-2 size-4" /> Profile
          </TabsTrigger>
          <TabsTrigger value="enrollment" className="data-[state=active]:bg-muted">
            <Ticket className="mr-2 size-4" /> Enrollment
          </TabsTrigger>
          <TabsTrigger value="config" className="data-[state=active]:bg-muted">
            <Settings2 className="mr-2 size-4" /> Config
          </TabsTrigger>
          <TabsTrigger value="users" className="data-[state=active]:bg-muted">
            <Users className="mr-2 size-4" /> Users
            {users.length > 0 ? (
              <span className="ml-1.5 tabular-nums text-muted-foreground">{users.length}</span>
            ) : null}
          </TabsTrigger>
          {isAdmin ? (
            <TabsTrigger value="recovery" className="data-[state=active]:bg-muted">
              <LifeBuoy className="mr-2 size-4" /> Recovery
            </TabsTrigger>
          ) : null}
        </TabsList>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <TabsContent value="profile" className="mt-0">
            <Card className="bg-card border-border">
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-sm font-semibold tracking-tight">Vessel Profile</CardTitle>
                <CardDescription className="text-xs">Shore-side master data and edge node telemetry.</CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Name">{vessel.name}</Field>
                  <Field label="IMO Number">
                    <span className="font-mono tabular-nums">{vessel.imo}</span>
                  </Field>
                  <Field label="Type">{vessel.type || <span className="text-muted-foreground">—</span>}</Field>
                  <Field label="Tags">
                    {vessel.groups.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {vessel.groups.map((g) => (
                          <Badge key={g} variant="outline" className="bg-muted/50 text-xs">
                            {g}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </Field>
                  <Field label="Last Sync">{relativeTime(sync.lastSeenAt)}</Field>
                  <Field label="Node Version">
                    {sync.appVersion || <span className="text-muted-foreground">Unknown</span>}
                  </Field>
                </dl>

                {identityDrift ? (
                  <div className="mt-6 rounded-md border border-status-warn/25 bg-status-warn/10 p-3">
                    <p className="text-xs font-semibold text-status-warn">Node reports a different identity</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      This node last checked in as{' '}
                      <span className="text-foreground">{sync.reportedName || '(no name)'}</span>
                      {sync.reportedImo ? <span className="font-mono"> / IMO {sync.reportedImo}</span> : null}. Shore is
                      authoritative and the node adopts these values on its next sync.
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="enrollment" className="mt-0">
            <Card className="bg-card border-border">
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-sm font-semibold tracking-tight">Enrollment</CardTitle>
                <CardDescription className="text-xs">
                  A single-use code lets this node collect its own identity and sync credential.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                  <Field label="State">
                    {enrollment ? (
                      <Badge
                        variant="outline"
                        className={
                          enrollment.state === 'enrolled'
                            ? 'border-status-ok/30 bg-status-ok/10 text-status-ok'
                            : enrollment.state === 'issued'
                              ? 'border-status-warn/30 bg-status-warn/10 text-status-warn'
                              : 'border-border bg-muted text-muted-foreground'
                        }
                      >
                        {enrollment.state}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Never enrolled</span>
                    )}
                  </Field>
                  <Field label="Issued">{relativeTime(enrollment?.issuedAt)}</Field>
                  <Field label="Revoked">{enrollment?.revokedAt ? relativeTime(enrollment.revokedAt) : '—'}</Field>
                </dl>

                {enrollment?.codeOutstanding ? (
                  <div className="rounded-md border border-status-warn/25 bg-status-warn/10 p-3">
                    <p className="text-xs font-semibold text-status-warn">A code is outstanding</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      It has not been redeemed yet. Issuing a new one invalidates it.
                    </p>
                  </div>
                ) : null}

                {/* Sync credential state, separate from enrollment state:
                    a vessel can be enrolled but have had its credential
                    revoked, which is exactly the case Reset Credentials
                    produces and which was previously invisible anywhere. */}
                <div className="border-t border-border pt-4">
                  <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                    <Field label="Sync Credential">
                      {credential ? (
                        <Badge
                          variant="outline"
                          className={
                            credential.active
                              ? 'border-status-ok/30 bg-status-ok/10 text-status-ok'
                              : 'border-status-critical/30 bg-status-critical/10 text-status-critical'
                          }
                        >
                          {credential.active ? 'Active' : 'Revoked'}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">Never issued</span>
                      )}
                    </Field>
                    <Field label="Credential Issued">{relativeTime(credential?.issuedAt)}</Field>
                    <Field label="Credential Revoked">
                      {credential?.revokedAt ? relativeTime(credential.revokedAt) : '—'}
                    </Field>
                  </dl>
                  {credential && !credential.active ? (
                    <p className="mt-3 text-xs text-status-critical">
                      This vessel cannot sync. Issue a new enrollment code to bring it back online.
                    </p>
                  ) : null}
                </div>

                {isAdmin ? (
                  <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                    <Button onClick={() => setConfirmIssue(true)} disabled={issueMutation.isPending}>
                      <Ticket className="mr-2 size-4" />
                      {enrollment?.codeOutstanding ? 'Reissue Code' : 'Issue Enrollment Code'}
                    </Button>
                    {enrollment?.codeOutstanding ? (
                      <Button
                        variant="outline"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate({ vesselId })}
                        className="border-border bg-transparent text-foreground hover:bg-muted"
                      >
                        <KeyRound className="mr-2 size-4" />
                        {revokeMutation.isPending ? 'Revoking…' : 'Revoke Code'}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p className="border-t border-border pt-4 text-xs text-muted-foreground">
                    Only an Admin can issue or revoke enrollment codes.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="config" className="mt-0">
            <Card className="bg-card border-border">
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-sm font-semibold tracking-tight">Applied Configuration</CardTitle>
                <CardDescription className="text-xs">
                  The config bundle this vessel resolves to, by assignment scope.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                {bundle ? (
                  <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                    <Field label="Bundle">
                      <span className="font-mono text-xs">{bundle.bundleId}</span>
                    </Field>
                    <Field label="Version">
                      <span className="tabular-nums">{bundle.versionNo}</span>
                    </Field>
                    <Field label="Published">{new Date(bundle.publishedAt).toLocaleString()}</Field>
                  </dl>
                ) : (
                  <div className="py-6 text-center">
                    <p className="text-sm text-muted-foreground">No config bundle covers this vessel.</p>
                    <Link
                      href="/configuration"
                      className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
                    >
                      Assign one in Fleet Configuration →
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="users" className="mt-0">
            <Card className="bg-card border-border">
              <CardHeader className="flex flex-row items-center justify-between border-b border-border pb-4">
                <div>
                  <CardTitle className="text-sm font-semibold tracking-tight">Crew Accounts</CardTitle>
                  <CardDescription className="text-xs">
                    Mirrored from the vessel on each sync check-in.
                  </CardDescription>
                </div>
                {isAdmin ? (
                  <Button variant="outline" onClick={() => setUsersOpen(true)} className="border-border bg-transparent">
                    <Users className="mr-2 size-4" /> Manage
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent className="pt-6">
                {users.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No crew accounts reported yet — the roster arrives with the vessel&apos;s next sync.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-md border border-border">
                    {users.map((u: { username: string; role: string; active: boolean }) => (
                      <div key={u.username} className="flex items-center gap-3 px-3 py-2.5">
                        <span
                          className={`inline-block size-2 shrink-0 rounded-full ${u.active ? 'bg-status-ok' : 'bg-muted-foreground'}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{u.username}</span>
                        <Badge variant="outline" className="bg-muted/50 text-xs">
                          {u.role}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}

                {userCommands.length > 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {userCommands.length} queued command{userCommands.length === 1 ? '' : 's'} awaiting the next sync.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>

          {isAdmin ? (
            <TabsContent value="recovery" className="mt-0">
              <DisasterRecoveryTab vesselId={vesselId} vesselName={vessel.name} />
            </TabsContent>
          ) : null}
        </div>
      </Tabs>

      <Dialog open={confirmIssue} onOpenChange={(o) => !o && setConfirmIssue(false)}>
        <DialogContent className="border-border bg-background text-foreground sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{enrollment?.codeOutstanding ? 'Reissue enrollment code?' : 'Issue enrollment code?'}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Generates a single-use code for <span className="font-medium text-foreground">{vessel.name}</span>. The
            crew enter it during setup and the node collects its own identity and sync credential.
          </p>
          {enrollment?.codeOutstanding ? (
            <p className="text-xs text-status-warn">The code currently outstanding will stop working.</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmIssue(false)} className="border-border bg-transparent">
              Cancel
            </Button>
            <Button onClick={() => issueMutation.mutate({ vesselId })} disabled={issueMutation.isPending}>
              {issueMutation.isPending ? 'Issuing…' : 'Issue Code'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shown once and never again — dismissed only by an explicit
          acknowledgement, never on a timer or as a side effect of copy. */}
      <Dialog open={!!issuedCode} onOpenChange={(o) => !o && setIssuedCode(null)}>
        <DialogContent className="border-border bg-background text-foreground sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Enrollment code for {vessel.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Give this to the vessel now. It cannot be shown again — if it&apos;s lost, issue a new one.
          </p>
          <div className="rounded-md border border-status-ok/25 bg-status-ok/10 p-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 select-all text-center font-mono text-lg tracking-[0.2em] text-status-ok">
                {issuedCode}
              </code>
              <Button
                variant="outline"
                aria-label="Copy enrollment code"
                onClick={() => issuedCode && copyCode(issuedCode)}
                className="size-9 shrink-0 border-status-ok/30 bg-status-ok/10 p-0 text-status-ok hover:bg-status-ok/20"
              >
                {copied ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <p className="mt-2 text-center text-xs text-status-ok/80">
              Single use · {vessel.name} · IMO {vessel.imo}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssuedCode(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {usersOpen ? (
        <VesselUsersDialog
          vesselId={vesselId}
          vesselName={vessel.name}
          open={usersOpen}
          onOpenChange={(o: boolean) => setUsersOpen(o)}
        />
      ) : null}
    </div>
  );
}
