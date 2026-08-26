import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@ovl/ui/components/button';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center space-y-5">
        <div className="mx-auto w-12 h-12 rounded-full bg-muted border border-border flex items-center justify-center">
          <Compass className="w-6 h-6 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-foreground">There&apos;s nothing here</h1>
          <p className="text-sm text-muted-foreground">
            That address doesn&apos;t match a page on this terminal. If you followed a link to
            a report, it may have been removed since.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/" />}>Back to Dashboard</Button>
      </div>
    </div>
  );
}
