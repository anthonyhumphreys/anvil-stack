import { describe, expect, it } from 'vitest';
import { stripWorkItemHtml } from '../WorkItemThreadRail';

describe('stripWorkItemHtml', () => {
  it('converts common provider HTML into readable plain text', () => {
    expect(
      stripWorkItemHtml(
        '<p>Build the thing<br/>Then test it</p><ul><li>Acceptance &amp; review</li></ul>',
      ),
    ).toBe('Build the thing\nThen test it\n- Acceptance & review');
  });
});
