export function SurfaceSkeleton({ label = 'Loading preview' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2 py-2">
      <span className="block h-3 w-2/3 rounded bg-bg-tertiary motion-safe:animate-pulse" />
      <span className="block h-3 w-1/2 rounded bg-bg-tertiary motion-safe:animate-pulse" />
      <span className="block h-3 w-3/5 rounded bg-bg-tertiary motion-safe:animate-pulse" />
    </div>
  );
}
