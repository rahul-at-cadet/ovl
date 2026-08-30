/**
 * The placeholder a dashboard route shows while its data loads.
 *
 * Both apps had this same shape inline in their own `loading.tsx`. Next.js
 * requires that file to exist per route segment and to default-export a
 * component, so the file stays in each app and renders this — the markup is
 * what was duplicated, not the routing.
 */
export function RouteSkeleton() {
  return (
    <div className="w-full h-full flex flex-col space-y-4 p-8 animate-pulse">
      <div className="h-8 bg-muted rounded w-1/4"></div>
      <div className="h-32 bg-card rounded w-full border border-border"></div>
      <div className="h-64 bg-card rounded w-full border border-border"></div>
    </div>
  );
}
