'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '../lib/utils';

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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access is denied outside a secure context. The value is
      // still selectable, so leave the button unchanged rather than
      // claiming a copy that didn't happen.
      setCopied(false);
    }
  };

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-card p-2 pl-3',
        className,
      )}
    >
      <code className="flex-1 min-w-0 font-mono text-base tracking-wider text-foreground break-all select-all text-left">
        {value}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 text-status-ok" />
            Copied
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5" />
            Copy
          </>
        )}
      </button>
    </div>
  );
}
