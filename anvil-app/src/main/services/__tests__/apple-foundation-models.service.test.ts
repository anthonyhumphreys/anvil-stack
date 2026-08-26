import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

import { parseLocalLlmRouteResponse } from '../local-llm.service.js';

describe('parseLocalLlmRouteResponse', () => {
  it('parses a strict JSON local route', () => {
    expect(parseLocalLlmRouteResponse('{"route": "local"}')).toBe('local');
  });

  it('parses a strict JSON cloud route', () => {
    expect(parseLocalLlmRouteResponse('{"route": "cloud"}')).toBe('cloud');
  });

  it('parses JSON embedded in surrounding prose', () => {
    expect(parseLocalLlmRouteResponse('Sure! Here you go: {"route": "cloud"} Hope that helps.')).toBe(
      'cloud',
    );
  });

  it('parses bare route words', () => {
    expect(parseLocalLlmRouteResponse('local')).toBe('local');
    expect(parseLocalLlmRouteResponse('  CLOUD  ')).toBe('cloud');
    expect(parseLocalLlmRouteResponse('"local"')).toBe('local');
  });

  it('returns null for unexpected route values', () => {
    expect(parseLocalLlmRouteResponse('{"route": "hybrid"}')).toBeNull();
  });

  it('returns null for garbage, empty, and missing responses', () => {
    expect(parseLocalLlmRouteResponse('I think this needs a bigger model.')).toBeNull();
    expect(parseLocalLlmRouteResponse('{"answer": 42}')).toBeNull();
    expect(parseLocalLlmRouteResponse('')).toBeNull();
    expect(parseLocalLlmRouteResponse(undefined)).toBeNull();
    expect(parseLocalLlmRouteResponse(null)).toBeNull();
  });
});
