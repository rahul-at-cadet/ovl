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
          That address doesn&apos;t match a page in this app. If you followed a link to a report
          or vessel, it may have been deleted since.
        </>
      }
    >
      <Button nativeButton={false} render={<Link href="/" />}>Back to Fleet Overview</Button>
    </FullPageState>
  );
}
