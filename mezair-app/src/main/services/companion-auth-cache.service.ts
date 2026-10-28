// Keeps sync runtime decoupled from the Electron-backed companion service.
const cacheInvalidators = new Set<() => void>();

export function registerCompanionAuthCacheInvalidator(invalidator: () => void): () => void {
  cacheInvalidators.add(invalidator);
  return () => cacheInvalidators.delete(invalidator);
}

export function clearCompanionAuthCaches(): void {
  for (const invalidate of cacheInvalidators) invalidate();
}
