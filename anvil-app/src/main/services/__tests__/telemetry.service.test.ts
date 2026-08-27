import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock('@sentry/electron/main', () => ({
  init: mocks.init,
}));

import { initializeTelemetry } from '../telemetry.service.js';

describe('initializeTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not initialize Sentry before the user opts in', () => {
    expect(
      initializeTelemetry({
        enabled: false,
        release: 'anvil@0.6.8',
        environment: 'production',
      }),
    ).toBe(false);
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it('initializes privacy-limited crash reporting after opt-in', () => {
    expect(
      initializeTelemetry({
        enabled: true,
        release: 'anvil@0.6.8',
        environment: 'production',
      }),
    ).toBe(true);
    expect(mocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        release: 'anvil@0.6.8',
        environment: 'production',
        sendDefaultPii: false,
        maxBreadcrumbs: 0,
        tracesSampleRate: 0,
        autoSessionTracking: false,
        attachScreenshot: false,
      }),
    );
  });
});
