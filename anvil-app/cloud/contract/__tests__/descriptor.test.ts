import { describe, expect, it } from 'vitest';

import { resolveBackendPaths, validateDescriptor } from '../discovery';
import invalidDescriptor from '../fixtures/invalid-descriptor.json';
import validDescriptor from '../fixtures/valid-descriptor.json';

describe('validateDescriptor', () => {
  it('accepts the spec section 2 example', () => {
    const result = validateDescriptor(validDescriptor);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.descriptor.apiPath).toBe('v1');
      expect(result.descriptor.profiles).toEqual(['sync/1', 'mesh/1']);
    }
  });

  it('rejects the invalid fixture with protocol and path errors', () => {
    const result = validateDescriptor(invalidDescriptor);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('anvil-backend/1'))).toBe(true);
      expect(result.errors.some((e) => e.includes('apiPath') && e.includes('leading slash'))).toBe(
        true,
      );
    }
  });

  it('rejects non-object input', () => {
    expect(validateDescriptor(null)).toEqual({
      ok: false,
      errors: ['descriptor must be a JSON object'],
    });
    expect(validateDescriptor('https://example.com')).toMatchObject({ ok: false });
  });

  it('rejects parent traversal segments', () => {
    const result = validateDescriptor({ ...validDescriptor, apiPath: 'v1/../../etc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('Parent traversal') || e.includes('..'))).toBe(
        true,
      );
    }
  });

  it('rejects schemes, authorities, queries, and fragments in paths', () => {
    for (const apiPath of [
      'https://evil.example/v1',
      'v1?token=abc',
      'v1#frag',
      '//evil.example/v1',
      'v1\\windows',
    ]) {
      const result = validateDescriptor({ ...validDescriptor, apiPath });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects unknown profiles, auth modes, and bad limits', () => {
    const profiles = validateDescriptor({ ...validDescriptor, profiles: ['sync/1', 'quantum/9'] });
    expect(profiles.ok).toBe(false);

    const authModes = validateDescriptor({ ...validDescriptor, authModes: ['api-key'] });
    expect(authModes.ok).toBe(false);

    const limits = validateDescriptor({
      ...validDescriptor,
      limits: { ...validDescriptor.limits, batchChanges: 0 },
    });
    expect(limits.ok).toBe(false);
  });
});

describe('resolveBackendPaths', () => {
  it('normalizes a missing trailing slash and resolves api over https, socket over wss', () => {
    const resolved = resolveBackendPaths('https://backend.example.com/anvil', validDescriptor);
    expect(resolved.apiUrl).toBe('https://backend.example.com/anvil/v1');
    expect(resolved.socketUrl).toBe('wss://backend.example.com/anvil/v1/connect');
  });

  it('keeps an explicit trailing slash base identical', () => {
    const resolved = resolveBackendPaths('https://backend.example.com/anvil/', validDescriptor);
    expect(resolved.apiUrl).toBe('https://backend.example.com/anvil/v1');
  });

  it('rejects plain http for non-loopback hosts', () => {
    expect(() =>
      resolveBackendPaths('http://backend.example.com/anvil/', validDescriptor),
    ).toThrow(/https/);
  });

  it('rejects plain http for loopback without the explicit opt-in', () => {
    expect(() => resolveBackendPaths('http://127.0.0.1:8787/', validDescriptor)).toThrow(/https/);
  });

  it('allows loopback http with the explicit flag and uses ws for the socket', () => {
    const resolved = resolveBackendPaths('http://127.0.0.1:8787/', validDescriptor, {
      allowLoopbackHttp: true,
    });
    expect(resolved.apiUrl).toBe('http://127.0.0.1:8787/v1');
    expect(resolved.socketUrl).toBe('ws://127.0.0.1:8787/v1/connect');
  });

  it('rejects descriptors whose paths could leave the base origin', () => {
    const absolute = validateDescriptor({
      ...validDescriptor,
      apiPath: 'https://other.example/v1',
    });
    expect(absolute.ok).toBe(false);
    expect(() =>
      resolveBackendPaths(
        'https://backend.example.com/',
        absolute.ok ? absolute.descriptor : ({} as never),
      ),
    ).toThrow();
  });

  it('rejects credentialed base URLs and invalid descriptor input', () => {
    expect(() =>
      resolveBackendPaths('https://user:pass@backend.example.com/', validDescriptor),
    ).toThrow(/credentials/);
    expect(() => resolveBackendPaths('https://backend.example.com/', invalidDescriptor)).toThrow(
      /invalid backend descriptor/,
    );
    expect(() => resolveBackendPaths('not a url', validDescriptor)).toThrow();
  });
});
