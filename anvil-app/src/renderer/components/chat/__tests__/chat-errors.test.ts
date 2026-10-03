import { describe, expect, it } from 'vitest';
import { chatErrorSupportsProviderSwitch, classifyChatError } from '../chat-errors';

describe('classifyChatError', () => {
  it('classifies auth failures', () => {
    expect(classifyChatError('HTTP 401 Unauthorized').kind).toBe('auth');
    expect(classifyChatError('Invalid API key provided').kind).toBe('auth');
    expect(classifyChatError('token expired, please sign in again').kind).toBe('auth');
  });

  it('classifies rate limits', () => {
    expect(classifyChatError('429 Too Many Requests').kind).toBe('rate-limit');
    expect(classifyChatError('Rate limit exceeded for this model').kind).toBe('rate-limit');
    expect(classifyChatError('quota exhausted').kind).toBe('rate-limit');
  });

  it('classifies provider outages', () => {
    expect(classifyChatError('fetch failed: ECONNREFUSED').kind).toBe('provider');
    expect(classifyChatError('503 Service Unavailable').kind).toBe('provider');
    expect(classifyChatError('spawn codex ENOENT').kind).toBe('provider');
  });

  it('classifies sandbox denials', () => {
    expect(classifyChatError('EACCES: permission denied, open /etc/hosts').kind).toBe('sandbox');
    expect(classifyChatError('operation not permitted by sandbox').kind).toBe('sandbox');
  });

  it('falls back to generic for unrecognized errors', () => {
    expect(classifyChatError('the model returned malformed output').kind).toBe('generic');
    expect(classifyChatError('').kind).toBe('generic');
  });

  it('prefers sandbox over auth when both patterns appear', () => {
    expect(classifyChatError('sandbox: permission denied for credentials file').kind).toBe(
      'sandbox',
    );
  });

  it('offers provider switching for auth, rate-limit, and provider errors', () => {
    expect(chatErrorSupportsProviderSwitch('auth')).toBe(true);
    expect(chatErrorSupportsProviderSwitch('rate-limit')).toBe(true);
    expect(chatErrorSupportsProviderSwitch('provider')).toBe(true);
    expect(chatErrorSupportsProviderSwitch('sandbox')).toBe(false);
    expect(chatErrorSupportsProviderSwitch('generic')).toBe(false);
  });
});
