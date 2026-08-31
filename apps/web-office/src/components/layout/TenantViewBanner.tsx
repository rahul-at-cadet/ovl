'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Lock, PencilLine, ShieldAlert, Unlock } from 'lucide-react';
import { Button } from '@ovl/ui/components/button';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { ConfirmDialog } from '@ovl/ui/components/confirm-dialog';
import { trpc } from '@/lib/trpc';

/**
 * The strip that says a platform super admin is inside a customer's tenant.
 *
 * It lives in the shell rather than on the Tenant Management page, because
 * that page is the one place where the fact is already obvious. The risk is
 * every other screen: an operator who picked a tenant, went to Incoming
 * Reports and came back later has nothing else telling them whose fleet they
 * are reading — and, in write mode, whose data they are about to change.
 *
 * The mode control belongs here for the same reason. Read is where an
 * operator spends nearly all their time; write is entered deliberately, is
 * visible on every screen it applies to, and lapses on its own. The expiry is
 * enforced in the database (see TenantSelectionService) — the countdown below
 * only mirrors it, and is never what makes a write stop working.
 */

/** How long is left on the write window, in words rather than a clock. */
function remainingLabel(ms: number): string {
  if (ms <= 0) return 'expiring';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.ceil(seconds / 60)} min left`;
}

export function TenantViewBanner() {
  const router = useRouter();
  const utils = trpc.useUtils();

  // Same query key the shell's nav already uses, so this costs no extra
  // round trip — React Query serves both from one cache entry.
  const { data: capabilities, error: capabilitiesError } = trpc.tenants.capabilities.useQuery();
  const viewing = capabilities?.viewing ?? null;

  // `capabilities` is refused outright for an identity that is both a tenant
  // member and a platform super admin — see the tenancy README, "Super admins
  // belong to no tenant". Without this the refusal is invisible: the banner
  // returns null, every page falls back to its own empty state, and the
  // operator is left with a working-looking application showing nothing.
  // This strip is the right place for it because it is the one piece of chrome
  // that appears on every screen, and it is exactly where the wrong answer
  // used to be shown.
  const refusal =
    capabilitiesError?.data?.code === 'FORBIDDEN' ? capabilitiesError.message : null;

  const [confirmWriteOpen, setConfirmWriteOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const expiresAt = viewing?.writeExpiresAt ? Date.parse(viewing.writeExpiresAt) : null;

  const expired = expiresAt !== null && now >= expiresAt;

  // Ticks only while a write window is open and still has time on it, so an
  // idle read-mode banner costs nothing.
  useEffect(() => {
    if (expiresAt === null || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, expired]);

  // The instant it lapses, refetch — otherwise the banner sits at zero still
  // claiming write access the server has already stopped honouring.
  useEffect(() => {
    if (!expired) return;
    void utils.tenants.capabilities.invalidate();
  }, [expired, utils]);

  const setModeMutation = trpc.tenants.setMode.useMutation({
    meta: { errorTitle: "Couldn't change access mode" },
    // Mode decides what a request may write, not what it reads, so the rest
    // of the cache is still correct — only this query is stale.
    onSuccess: () => utils.tenants.capabilities.invalidate(),
  });

  const stopViewingMutation = trpc.tenants.stopViewing.useMutation({
    meta: { errorTitle: "Couldn't stop viewing that tenant" },
    onSuccess: async () => {
      // Every other screen is holding that tenant's rows; left cached they
      // would go on showing one tenant's data under no tenant at all. Tenant
      // Management is then the only page that still works, so go there.
      await utils.invalidate();
      router.push('/tenants');
    },
  });

  if (refusal) {
    return (
      <div className="shrink-0 border-b border-status-critical/40 bg-status-critical/10 px-4 lg:px-8 py-2">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 shrink-0 text-status-critical mt-px" />
          <p className="text-xs text-muted-foreground min-w-0">
            <span className="text-foreground font-medium">
              This account cannot be served.
            </span>{' '}
            {refusal}
          </p>
        </div>
      </div>
    );
  }

  if (!viewing) return null;

  const isWrite = viewing.mode === 'write';
  const ModeIcon = isWrite ? PencilLine : Eye;

  return (
    <>
      <div
        className={`shrink-0 border-b px-4 lg:px-8 py-2 ${
          isWrite
            ? 'border-status-attention/40 bg-status-attention/10'
            : 'border-status-info/30 bg-status-info/5'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <ModeIcon
              className={`w-4 h-4 shrink-0 ${isWrite ? 'text-status-attention' : 'text-status-info'}`}
            />
            <p className="text-xs text-muted-foreground min-w-0 truncate">
              <span className="text-foreground font-medium">Viewing {viewing.name}</span>
              <span className="hidden lg:inline">
                {isWrite
                  ? " — changes you make here are that tenant's live data."
                  : " — every screen is showing that tenant's data."}
              </span>
            </p>
            <StatusBadge
              role={isWrite ? 'attention' : 'info'}
              label={isWrite ? 'Write access' : 'Read-only'}
              size="sm"
            />
            {isWrite && expiresAt !== null && (
              <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {remainingLabel(expiresAt - now)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isWrite ? (
              <Button
                variant="outline"
                size="sm"
                disabled={setModeMutation.isPending}
                onClick={() => setModeMutation.mutate({ mode: 'read' })}
              >
                <Lock className="w-3.5 h-3.5" />
                Return to read-only
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmWriteOpen(true)}>
                <Unlock className="w-3.5 h-3.5" />
                Enable write access
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={stopViewingMutation.isPending}
              onClick={() => stopViewingMutation.mutate()}
            >
              <EyeOff className="w-3.5 h-3.5" />
              Stop viewing
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmWriteOpen}
        onOpenChange={setConfirmWriteOpen}
        title={`Enable write access to ${viewing.name}?`}
        description={
          <>
            <p>
              You will be able to change this tenant&apos;s live data — its users, vessels,
              reports and configuration — exactly as one of its own administrators could.
            </p>
            <p className="mt-2">
              Write access lapses back to read-only after 30 minutes, and is dropped
              immediately if you switch to a different tenant.
            </p>
          </>
        }
        confirmLabel="Enable write access"
        pendingLabel="Enabling..."
        confirmVariant="destructive"
        pending={setModeMutation.isPending}
        onConfirm={() =>
          setModeMutation.mutate(
            { mode: 'write' },
            { onSuccess: () => setConfirmWriteOpen(false) },
          )
        }
      />
    </>
  );
}
