import { describe, expect, it } from 'vitest';
import {
  buildApprovalPolicy,
  isCarPlayActionAllowed,
  isCarPlayApprovable,
} from '../companion-policy';
import type { MobileApprovalRequest } from '../types';

const baseApproval: MobileApprovalRequest = {
  sessionId: 'session-1',
  requestKey: 'request-1',
  requestId: 'request-1',
  kind: 'command',
  command: 'pnpm test',
  createdAt: '2026-05-27T10:00:00.000Z',
};

describe('companion CarPlay policy', () => {
  it('allows low-risk approvals explicitly allowed on CarPlay', () => {
    const policy = buildApprovalPolicy(baseApproval);

    expect(policy.risk).toBe('low');
    expect(isCarPlayApprovable(policy)).toBe(true);
  });

  it('blocks low-risk approvals not explicitly allowed on CarPlay', () => {
    expect(
      isCarPlayApprovable({
        risk: 'low',
        requiresFullReview: false,
        allowedSurfaces: ['desktop', 'mobile'],
      }),
    ).toBe(false);
  });

  it('blocks low-risk approvals that require full review', () => {
    expect(
      isCarPlayApprovable({
        risk: 'low',
        requiresFullReview: true,
        allowedSurfaces: ['desktop', 'mobile', 'carplay'],
      }),
    ).toBe(false);
  });

  it('blocks medium, high, destructive, and unknown-risk commands from approval', () => {
    const filePolicy = buildApprovalPolicy({ ...baseApproval, kind: 'file_change' });
    const highPolicy = buildApprovalPolicy({ ...baseApproval, command: 'npm install left-pad' });
    const destructivePolicy = buildApprovalPolicy({ ...baseApproval, command: 'rm -rf dist' });
    const unknownPolicy = buildApprovalPolicy({ ...baseApproval, command: 'do the thing' });

    expect(filePolicy.risk).toBe('medium');
    expect(isCarPlayApprovable(filePolicy)).toBe(false);
    expect(highPolicy.risk).toBe('high');
    expect(isCarPlayApprovable(highPolicy)).toBe(false);
    expect(destructivePolicy.risk).toBe('destructive');
    expect(isCarPlayApprovable(destructivePolicy)).toBe(false);
    expect(unknownPolicy.risk).toBe('high');
    expect(isCarPlayApprovable(unknownPolicy)).toBe(false);
  });

  it('allows decline, pause, and mark-later for non-low-risk approvals', () => {
    const policy = buildApprovalPolicy({ ...baseApproval, command: 'deploy production' });

    expect(isCarPlayActionAllowed(policy, 'decline')).toBe(true);
    expect(isCarPlayActionAllowed(policy, 'pause')).toBe(true);
    expect(isCarPlayActionAllowed(policy, 'mark-for-later')).toBe(true);
    expect(isCarPlayActionAllowed(policy, 'approve')).toBe(false);
  });
});
