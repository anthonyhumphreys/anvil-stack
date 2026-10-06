import { describe, expect, it } from 'vitest';
import { isMeshEndpointFlagEnabled } from '../mesh-endpoint-flag.service.js';

describe('Mesh endpoint feature flags', () => {
  it('enables endpoints by default and accepts explicit runtime or build settings', () => {
    expect(isMeshEndpointFlagEnabled(undefined, undefined)).toBe(true);
    expect(isMeshEndpointFlagEnabled('true', undefined)).toBe(true);
    expect(isMeshEndpointFlagEnabled(undefined, 'true')).toBe(true);
    expect(isMeshEndpointFlagEnabled('true', 'false')).toBe(true);
  });

  it('lets an explicit runtime false override the build flag and rejects invalid settings', () => {
    expect(isMeshEndpointFlagEnabled(undefined, 'false')).toBe(false);
    expect(isMeshEndpointFlagEnabled('false', 'true')).toBe(false);
    expect(isMeshEndpointFlagEnabled('false', 'false')).toBe(false);
    expect(isMeshEndpointFlagEnabled('TRUE', '1')).toBe(false);
  });
});
