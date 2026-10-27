export async function initializeRendererTelemetry(enabled: boolean): Promise<void> {
  if (!enabled) return;

  const Sentry = await import('@sentry/electron/renderer');
  Sentry.init({
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    autoSessionTracking: false,
  });
}
