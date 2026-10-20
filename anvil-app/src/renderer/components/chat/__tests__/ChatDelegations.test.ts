import { describe, expect, it } from 'vitest';
import { integrationApplicationHeadline } from '../ChatDelegations';

describe('integration application headline', () => {
  it('reports the retained checkout before any repository is applied', () => {
    expect(integrationApplicationHeadline(0, 2)).toBe(
      'The combined result is in a retained integration checkout. It has not been applied to your repository.',
    );
  });

  it('reports partial application by repository count', () => {
    expect(integrationApplicationHeadline(1, 2)).toBe(
      'Changes have been applied in 1 of 2 repositories. Apply each remaining repository separately.',
    );
  });

  it('states when every source repository has its own apply receipt', () => {
    expect(integrationApplicationHeadline(2, 2)).toBe(
      'Verified changes have been applied to each source repository.',
    );
  });
});
