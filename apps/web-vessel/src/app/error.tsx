'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@ovl/ui/components/button';
import { FullPageState } from '@ovl/ui/components/full-page-state';

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
    console.error('Unhandled error in vessel app:', error);
  }, [error]);

  return (
    <FullPageState
      icon={AlertTriangle}
      tone="critical"
      title="This screen didn't load"
      description={
        <>
          Something went wrong rendering this page. Any saved report data is untouched — trying
          again is safe.
        </>
      }
      // The digest is the only handle support has on a specific occurrence in
      // the server logs, so it has to be visible.
      reference={error.digest ? <>Reference: {error.digest}</> : undefined}
    >
      <Button onClick={() => retry()}>
        <RotateCcw className="w-4 h-4 mr-1.5" />
        Try again
      </Button>
      <Button variant="outline" onClick={() => window.location.assign('/')}>
        Back to Dashboard
      </Button>
    </FullPageState>
  );
}
