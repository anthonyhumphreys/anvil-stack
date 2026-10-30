const listeners = new Set<() => void>();

/** Session owners are invalidated before account identity is replaced or removed. */
export function invalidateMobileMeshAccount(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One observer cannot leave other session owners attached to the old account.
    }
  }
}

export function onMobileMeshAccountInvalidated(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function mobileMeshAccountScope(connection: {
  apiUrl: string;
  session: { accountId: string; enrollmentId: string; datasetEpoch: string };
}): string {
  return JSON.stringify([
    new URL(connection.apiUrl).href.replace(/\/+$/, ''),
    connection.session.accountId,
    connection.session.enrollmentId,
    connection.session.datasetEpoch,
  ]);
}
