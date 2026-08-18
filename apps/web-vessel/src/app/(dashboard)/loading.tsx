export default function Loading() {
  return (
    <div className="w-full h-full flex flex-col space-y-4 p-8 animate-pulse">
      <div className="h-8 bg-muted rounded w-1/4"></div>
      <div className="h-32 bg-card rounded w-full border border-border"></div>
      <div className="h-64 bg-card rounded w-full border border-border"></div>
    </div>
  );
}
