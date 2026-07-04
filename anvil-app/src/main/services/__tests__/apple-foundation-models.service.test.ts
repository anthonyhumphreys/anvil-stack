import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

import { parseOnDeviceRouteResponse } from '../apple-foundation-models.service.js';

describe('parseOnDeviceRouteResponse', () => {
  it('parses a strict JSON local route', () => {
    expect(parseOnDeviceRouteResponse('{"route": "local"}')).toBe('local');
  });

  it('parses a strict JSON cloud route', () => {
    expect(parseOnDeviceRouteResponse('{"route": "cloud"}')).toBe('cloud');
  });

  it('parses JSON embedded in surrounding prose', () => {
    expect(parseOnDeviceRouteResponse('Sure! Here you go: {"route": "cloud"} Hope that helps.')).toBe(
      'cloud',
    );
  });

  it('parses bare route words', () => {
    expect(parseOnDeviceRouteResponse('local')).toBe('local');
    expect(parseOnDeviceRouteResponse('  CLOUD  ')).toBe('cloud');
    expect(parseOnDeviceRouteResponse('"local"')).toBe('local');
  });

  it('returns null for unexpected route values', () => {
    expect(parseOnDeviceRouteResponse('{"route": "hybrid"}')).toBeNull();
  });

  it('returns null for garbage, empty, and missing responses', () => {
    expect(parseOnDeviceRouteResponse('I think this needs a bigger model.')).toBeNull();
    expect(parseOnDeviceRouteResponse('{"answer": 42}')).toBeNull();
    expect(parseOnDeviceRouteResponse('')).toBeNull();
    expect(parseOnDeviceRouteResponse(undefined)).toBeNull();
    expect(parseOnDeviceRouteResponse(null)).toBeNull();
  });
});
