import { describe, expect, it } from 'vitest';
import { BackendRpcError } from '../sync-backend-client.service.js';
import { describeMeshDispatchError } from '../mesh-dispatch-error.js';

describe('remote dispatch refusals', () => {
  it('explains an ineligible target without exposing backend-supplied text', () => {
    const error = new BackendRpcError({
      code: 'forbidden',
      retryable: false,
      details: { reason: 'target-not-eligible', privateValue: 'sensitive' },
    });
    const message = describeMeshDispatchError(error);
    expect(message).toContain('enable the worker');
    expect(message).not.toContain('sensitive');
  });

  it('identifies a hosted access refusal', () => {
    const error = new BackendRpcError({
      code: 'forbidden',
      retryable: false,
      details: { reason: 'billing-unavailable' },
    });
    expect(describeMeshDispatchError(error)).toContain('Hosted access');
  });

  it('does not display unrecognized backend reasons', () => {
    const error = new BackendRpcError({
      code: 'forbidden',
      retryable: false,
      details: { reason: 'private-token-value' },
    });
    expect(describeMeshDispatchError(error)).not.toContain('private-token-value');
  });
});
