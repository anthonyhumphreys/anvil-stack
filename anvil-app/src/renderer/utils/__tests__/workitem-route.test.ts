import { describe, expect, it } from 'vitest';
import { parseWorkItemReference } from '../workitem-route';

describe('parseWorkItemReference', () => {
  it('preserves a GitHub canonical issue URL in workflow context', () => {
    const id = 'https://github.com/acme/widget/issues/42';
    const params = new URLSearchParams({
      workItemId: id,
      workItemProvider: 'github',
      workItemConnection: 'connection-1',
    });

    expect(parseWorkItemReference(params)).toEqual({
      id,
      provider: 'github',
      connectionId: 'connection-1',
    });
  });

  it('rejects incomplete or unsupported work item references', () => {
    expect(parseWorkItemReference(new URLSearchParams('workItemProvider=github'))).toBeUndefined();
    expect(
      parseWorkItemReference(
        new URLSearchParams('workItemId=123&workItemProvider=unknown&workItemConnection=c'),
      ),
    ).toBeUndefined();
  });
});
