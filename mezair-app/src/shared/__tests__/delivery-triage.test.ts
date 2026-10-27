import { describe, expect, it } from 'vitest';
import { deliveryNextAction } from '../delivery-triage';

describe('delivery triage ownership', () => {
  it('keeps a paused workflow actionable after its launcher completes', () => {
    expect(deliveryNextAction('completed', 0, 'paused')).toEqual({
      attention: 'decision',
      nextAction: 'Open workflow to answer the pending decision',
    });
  });
  it('prioritises workflow recovery over launcher success', () => {
    expect(deliveryNextAction('completed', 1, 'failed').attention).toBe('blocked');
    expect(deliveryNextAction('completed', 1, 'cancelled').attention).toBe('blocked');
  });
  it('does not turn completed work into accepted evidence', () => {
    expect(deliveryNextAction('completed', 1, 'completed')).toEqual({
      attention: 'changes',
      nextAction: 'Review the retained candidate and record an evidence decision',
    });
    expect(deliveryNextAction('completed', 0).nextAction).toContain('unavailable');
  });
});
