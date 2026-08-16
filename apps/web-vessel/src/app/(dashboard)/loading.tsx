export default function Loading() {
  return (
    <div className="w-full h-full flex flex-col space-y-4 p-8 animate-pulse">
      <div className="h-8 bg-zinc-800 rounded w-1/4"></div>
      <div className="h-32 bg-zinc-900 rounded w-full border border-zinc-800"></div>
      <div className="h-64 bg-zinc-900 rounded w-full border border-zinc-800"></div>
    </div>
  );
}
