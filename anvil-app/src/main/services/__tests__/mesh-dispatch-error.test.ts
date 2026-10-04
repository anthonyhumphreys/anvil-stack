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

  it.each(['billing-unavailable', 'preview-ended', 'subscription-required'])(
    'identifies a legacy billing refusal (%s) without recommending payment',
    (reason) => {
      const error = new BackendRpcError({
        code: 'forbidden',
        retryable: false,
        details: { reason },
      });
      expect(describeMeshDispatchError(error)).toContain('Update the backend');
      expect(describeMeshDispatchError(error)).not.toContain('billing page');
    },
  );

  it('does not display unrecognized backend reasons', () => {
    const error = new BackendRpcError({
      code: 'forbidden',
      retryable: false,
      details: { reason: 'private-token-value' },
    });
    expect(describeMeshDispatchError(error)).not.toContain('private-token-value');
  });
});
