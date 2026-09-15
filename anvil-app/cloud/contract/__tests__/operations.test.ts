import { describe, expect, it } from 'vitest';

import {
  HOSTED_OPERATION_CLASS,
  OPERATIONS,
  type HostedOperationClass,
} from '../operations';

const CLASSES: readonly HostedOperationClass[] = ['mutating', 'control'];

describe('HOSTED_OPERATION_CLASS', () => {
  it('covers every frozen v1 operation exactly once', () => {
    expect(Object.keys(HOSTED_OPERATION_CLASS).sort()).toEqual([...OPERATIONS].sort());
    for (const operation of OPERATIONS) {
      expect(CLASSES).toContain(HOSTED_OPERATION_CLASS[operation]);
    }
  });

  it('keeps reads, cancellation, completion, and deletion in the control class', () => {
    expect(HOSTED_OPERATION_CLASS['sync.pull']).toBe('control');
    expect(HOSTED_OPERATION_CLASS['job.list']).toBe('control');
    expect(HOSTED_OPERATION_CLASS['attempt.report']).toBe('control');
    expect(HOSTED_OPERATION_CLASS['artifact.finalize']).toBe('control');
    expect(HOSTED_OPERATION_CLASS['account.delete']).toBe('control');
    expect(HOSTED_OPERATION_CLASS['data.export.begin']).toBe('control');
    expect(HOSTED_OPERATION_CLASS['handoff.cancel']).toBe('control');
  });

  it('marks new billable work mutating', () => {
    expect(HOSTED_OPERATION_CLASS['sync.push']).toBe('mutating');
    expect(HOSTED_OPERATION_CLASS['job.create']).toBe('mutating');
    expect(HOSTED_OPERATION_CLASS['job.claim']).toBe('mutating');
    expect(HOSTED_OPERATION_CLASS['attempt.renew']).toBe('mutating');
    expect(HOSTED_OPERATION_CLASS['artifact.reserve']).toBe('mutating');
    expect(HOSTED_OPERATION_CLASS['handoff.create']).toBe('mutating');
    expect(HOSTED_OPERATION_CLASS['data.import.commit']).toBe('mutating');
  });
});
