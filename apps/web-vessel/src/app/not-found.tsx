import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@ovl/ui/components/button';
import { FullPageState } from '@ovl/ui/components/full-page-state';

export default function NotFound() {
  return (
    <FullPageState
      icon={Compass}
      title="There's nothing here"
      description={
        <>
          That address doesn&apos;t match a page on this terminal. If you followed a link to
          a report, it may have been removed since.
        </>
      }
    >
      <Button nativeButton={false} render={<Link href="/" />}>Back to Dashboard</Button>
    </FullPageState>
  );
}
