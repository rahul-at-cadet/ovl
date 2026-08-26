'use client';

import { AlertCircle, Check, CloudOff, Loader2, PencilLine, RotateCcw } from 'lucide-react';

/**
 * Local save and shore sync are two different promises, and this terminal must
 * not blur them. A draft written to the vessel's own SQLite is durable and is
 * reported as such; whether it has reached the office is a separate, later
 * fact. The autosave used to run silently and discard its errors, so an
 * officer could fill in a whole section while every write bounced.
 */
export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'failed'; message: string };

interface SaveStatusProps {
  state: SaveState;
  /** True when edits exist that the next autosave tick hasn't written yet. */
  hasUnsavedEdits: boolean;
  /** Items still queued for shore, from sync status. */
  pendingSync?: number;
  onRetry: () => void;
}

function timeOfDay(at: Date) {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SaveStatus({ state, hasUnsavedEdits, pendingSync, onRetry }: SaveStatusProps) {
  // A failure outranks everything: it stays until a save actually succeeds, so
  // it cannot be scrolled past or blinked away.
  if (state.kind === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-sm text-status-critical bg-status-critical/10 border border-status-critical/40 rounded-sm px-3 py-2"
      >
        <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">Not saved locally</span>
        <span className="text-status-critical/90 min-w-0 break-words">{state.message}</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:no-underline shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  // Saved-locally and pending-sync are ordinary operational states on a vessel
  // that is offline by design — they stay neutral, never warning-coloured.
  const queued =
    pendingSync && pendingSync > 0 ? (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <CloudOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        {pendingSync} pending shore sync
      </span>
    ) : null;

  let primary: React.ReactNode = null;

  if (state.kind === 'saving') {
    primary = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
        Saving locally&hellip;
      </span>
    );
  } else if (hasUnsavedEdits) {
    primary = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <PencilLine className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Unsaved changes
      </span>
    );
  } else if (state.kind === 'saved') {
    primary = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Check className="w-3.5 h-3.5 text-status-ok shrink-0" aria-hidden="true" />
        Saved locally {timeOfDay(state.at)}
      </span>
    );
  }

  if (!primary && !queued) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-live="polite">
      {primary}
      {primary && queued && <span className="text-border" aria-hidden="true">|</span>}
      {queued}
    </p>
  );
}
