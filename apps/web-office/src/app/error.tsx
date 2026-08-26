'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@ovl/ui/components/button';

/**
 * Before this existed, an unhandled render error anywhere in the app
 * dropped the user on Next's default error screen with no way back and no
 * indication of what had happened.
 *
 * Note the prop is `retry`, not the `reset` from older Next versions — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error in office app:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center space-y-5">
        <div className="mx-auto w-12 h-12 rounded-full bg-status-critical/10 border border-status-critical/25 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-status-critical" />
        </div>
        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-foreground">This screen didn&apos;t load</h1>
          <p className="text-sm text-muted-foreground">
            Something went wrong rendering this page. Your data hasn&apos;t been changed — trying
            again is safe.
          </p>
        </div>
        {/* The digest is the only handle support has on a specific
            occurrence in the server logs, so it has to be visible. */}
        {error.digest && (
          <p className="text-xs text-muted-foreground font-mono">Reference: {error.digest}</p>
        )}
        <div className="flex items-center justify-center gap-2">
          <Button onClick={() => retry()}>
            <RotateCcw className="w-4 h-4 mr-1.5" />
            Try again
          </Button>
          <Button variant="outline" onClick={() => window.location.assign('/')}>
            Back to Fleet Overview
          </Button>
        </div>
      </div>
    </div>
  );
}
