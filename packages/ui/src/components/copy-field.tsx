'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';

import { cn } from '../lib/utils';

/**
 * Puts `text` on the clipboard, by whichever route this page is allowed.
 *
 * `navigator.clipboard` only exists in a secure context. This app is served
 * over plain HTTP on a bare IP in the deployed case, which is *not* one — so
 * `navigator.clipboard` is not merely restricted there, it is `undefined`,
 * and reaching for `.writeText` on it throws a TypeError before any promise
 * is created. localhost happens to count as secure, which is exactly why
 * this never showed up in development.
 *
 * `document.execCommand('copy')` carries no such requirement. It is
 * deprecated and it is also the only thing that works here, so it is the
 * fallback rather than the primary path.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Present but refused — a denied permission prompt, or a page that
      // wasn't focused at the moment of the call. Fall through.
    }
  }

  // execCommand copies the current selection, so the text has to be inside
  // a focused, selected, editable node. A fixed, transparent textarea does
  // that without the page visibly shifting; `readOnly` keeps the mobile
  // keyboard from appearing, and iOS needs the explicit setSelectionRange
  // because .select() alone is a no-op on a readOnly field there.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    // Restore whatever the user had selected before the button was clicked,
    // so copying doesn't silently blow away their selection on failure.
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

/**
 * A one-time secret with a way to actually take it.
 *
 * The onboarding and password-reset dialogs both show a generated temporary
 * password, tell the admin "make sure to copy this now — you won't be able to
 * see it again", and then offer no copy control at all. Select-all-and-drag
 * on a long monospace string is exactly where a transcription mistake gets
 * made, and the cost of one here is a locked-out crew member.
 */
export function CopyField({ value, className }: { value: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? 2000 : 6000);
    return () => clearTimeout(timer);
  }, [state]);

  const handleCopy = async () => {
    // Report the failure rather than resetting to the resting state. A
    // button that does nothing at all reads as a broken app, and the person
    // clicking it has one shot at this password: they need to be told to
    // select it by hand, not left guessing whether it worked.
    setState((await writeToClipboard(value)) ? 'copied' : 'failed');
  };

  const label =
    state === 'copied'
      ? 'Copied to clipboard'
      : state === 'failed'
        ? 'Copy failed — select the text and copy it manually'
        : 'Copy to clipboard';

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center gap-2 rounded-md border border-border bg-card p-2 pl-3">
        <code className="flex-1 min-w-0 font-mono text-base tracking-wider text-foreground break-all select-all text-left">
          {value}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={label}
          title={label}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {state === 'copied' ? (
            <>
              <Check className="w-3.5 h-3.5 text-status-ok" />
              Copied
            </>
          ) : state === 'failed' ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-status-warn" />
              Copy failed
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      {/* aria-live so a screen reader hears the outcome; the visual button
          label changes, but that change is not announced on its own. The
          node has to stay mounted for that to work, so `empty:hidden`
          collapses it instead of unmounting — otherwise it would occupy a
          line of height at rest and shift the dialog. */}
      <p className="text-xs text-status-warn empty:hidden" role="status" aria-live="polite">
        {state === 'failed'
          ? 'This browser blocked the clipboard. Select the value above and copy it manually.'
          : ''}
      </p>
    </div>
  );
}
