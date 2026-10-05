import { describe, expect, it } from 'vitest';
import { isMeshEndpointFlagEnabled } from '../mesh-endpoint-flag.service.js';

describe('Mesh endpoint feature flags', () => {
  it('accepts an explicit runtime setting or a staging preview build flag', () => {
    expect(isMeshEndpointFlagEnabled('true', undefined)).toBe(true);
    expect(isMeshEndpointFlagEnabled(undefined, 'true')).toBe(true);
    expect(isMeshEndpointFlagEnabled('true', 'false')).toBe(true);
  });

  it('lets an explicit runtime false override the build flag and stays disabled by default', () => {
    expect(isMeshEndpointFlagEnabled(undefined, undefined)).toBe(false);
    expect(isMeshEndpointFlagEnabled('false', 'true')).toBe(false);
    expect(isMeshEndpointFlagEnabled('false', 'false')).toBe(false);
    expect(isMeshEndpointFlagEnabled('TRUE', '1')).toBe(false);
  });
});
