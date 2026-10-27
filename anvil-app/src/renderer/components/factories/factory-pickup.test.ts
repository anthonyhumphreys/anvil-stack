import { describe, expect, it } from 'vitest';
import type { FactoryRun } from '../../../shared/factories';
import { recipientPickupThread, takeoverControlInput } from './factory-pickup';

describe('factory recipient pickup', () => {
  it('sends the recipient-selected workspace, repository and persona with the claim', () => {
    expect(
      takeoverControlInput('run-7', {
        workspaceId: 'recipient-ws',
        repoId: 'recipient-repo',
        personaId: 'coder',
      }),
    ).toEqual({
      runId: 'run-7',
      action: 'takeover',
      takeoverContext: {
        workspaceId: 'recipient-ws',
        repoId: 'recipient-repo',
        personaId: 'coder',
      },
    });
  });

  it('keeps the UI on the run while a remote claim is pending and opens only a returned local chat', () => {
    const pending = { takeoverThreadId: undefined } as Pick<FactoryRun, 'takeoverThreadId'>;
    expect(recipientPickupThread(pending)).toBeNull();
    expect(recipientPickupThread({ takeoverThreadId: 'recipient-private-thread' })).toBe(
      'recipient-private-thread',
    );
  });
});
