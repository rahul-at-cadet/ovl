import { ReportForm } from '@/components/ReportForm';

export default async function DraftReportPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const schemaName = typeof params.schema === 'string' ? params.schema : 'bunker-report.json';

  return (
    <div className="w-full">
      <ReportForm schemaName={schemaName} />
    </div>
  );
}
