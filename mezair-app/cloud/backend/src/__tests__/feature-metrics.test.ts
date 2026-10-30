import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitFeatureUsage, type FeatureUsage } from '../hosted/feature-metrics';

afterEach(() => vi.restoreAllMocks());

describe('sampled feature attribution', () => {
  it('selects only bounded metric fields and never logs extra caller data', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const input = {
      operation: 'attempt.renew',
      status: 200,
      wallMs: 9.8,
      batchItems: 2,
      accountId: 'private-account',
      accessToken: 'secret',
      payload: 'private-content',
    };
    emitFeatureUsage(input as FeatureUsage, 0);
    expect(log).toHaveBeenCalledOnce();
    const metric = JSON.parse(log.mock.calls[0]![0] as string);
    expect(metric).toMatchObject({
      metric: 'feature.usage',
      operation: 'attempt.renew',
      status: 200,
      sampleRate: 0.01,
      wallMs: 10,
      batchItems: 2,
    });
    expect(JSON.stringify(metric)).not.toMatch(/secret|private-/);
    expect(metric).not.toHaveProperty('accountId');
  });

  it('does not emit outside the sample or for unbounded operation labels', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const usage: FeatureUsage = { operation: 'sync.pull', status: 200, wallMs: 5 };
    emitFeatureUsage(usage, 0.01);
    emitFeatureUsage(usage, Number.NaN);
    emitFeatureUsage({ ...usage, operation: 'secret-user-path' } as unknown as FeatureUsage, 0);
    expect(log).not.toHaveBeenCalled();
  });

  it('drops invalid counts and caps extreme measurements', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitFeatureUsage(
      {
        operation: 'machine.ticket.consume',
        status: 403,
        wallMs: Infinity,
        requestBytes: -1,
        responseBytes: 2_000_000_000,
        batchItems: 99_999,
      },
      0,
    );
    const metric = JSON.parse(log.mock.calls[0]![0] as string);
    expect(metric).not.toHaveProperty('wallMs');
    expect(metric).not.toHaveProperty('requestBytes');
    expect(metric.responseBytes).toBe(1_073_741_824);
    expect(metric.batchItems).toBe(10_000);
  });
});
