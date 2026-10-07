/** Present the actionable message without Electron's IPC transport wrapper. */
export function presentSetupError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message
    .replace(/^Error:\s*/i, '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  return message || fallback;
}
