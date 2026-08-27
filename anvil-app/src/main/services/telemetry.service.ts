import * as Sentry from '@sentry/electron/main';

const SENTRY_DSN =
  'https://78b747e5e476aa804c1cf6160ba2dc5b@o4506611249643520.ingest.us.sentry.io/4511982729363456';

export interface TelemetryStartupOptions {
  enabled: boolean;
  release: string;
  environment: 'development' | 'production';
}

export function initializeTelemetry(options: TelemetryStartupOptions): boolean {
  if (!options.enabled) {
    console.log('[Telemetry] Crash reporting is disabled');
    return false;
  }

  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      release: options.release,
      environment: options.environment,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      autoSessionTracking: false,
      attachScreenshot: false,
    });
    console.log('[Telemetry] Crash reporting is enabled');
    return true;
  } catch (error) {
    console.warn('[Telemetry] Failed to initialize crash reporting:', error);
    return false;
  }
}
