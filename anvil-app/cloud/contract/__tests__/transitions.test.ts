import { describe, expect, it } from 'vitest';

import {
  canTransitionAttempt,
  canTransitionJob,
  AttemptState,
  JobState,
} from '../jobs';
import { canAdvanceHandoff, HandoffState } from '../handoff';
import { canTransitionArtifact } from '../artifacts';
import cancelRace from '../fixtures/cancel-race.json';
import handoffSequence from '../fixtures/handoff-sequence.json';

describe('job transitions', () => {
  it('advances queued jobs toward running, approval, or direct cancel', () => {
    expect(canTransitionJob('queued', 'running')).toBe(true);
    expect(canTransitionJob('queued', 'awaiting-approval')).toBe(true);
    expect(canTransitionJob('queued', 'cancelled')).toBe(true);
    expect(canTransitionJob('queued', 'cancel-requested')).toBe(true);
    expect(canTransitionJob('queued', 'completed')).toBe(false);
  });

  it('lets running jobs complete but never jump to cancelled', () => {
    expect(canTransitionJob('running', 'completed')).toBe(true);
    expect(canTransitionJob('running', 'awaiting-approval')).toBe(true);
    expect(canTransitionJob('running', 'cancel-requested')).toBe(true);
    expect(canTransitionJob('running', 'cancelled')).toBe(false);
  });

  it('keeps terminal states terminal', () => {
    const terminals: JobState[] = ['completed', 'failed', 'cancelled', 'unknown-outcome'];
    const all: JobState[] = [
      'queued',
      'running',
      'awaiting-approval',
      'completed',
      'failed',
      'cancel-requested',
      'cancelled',
      'unknown-outcome',
    ];
    for (const from of terminals) {
      for (const to of all) {
        expect(canTransitionJob(from, to)).toBe(false);
      }
    }
  });

  it('enforces the cancel-vs-complete race from the fixture', () => {
    const attempted = cancelRace.attemptedCompletion as { from: JobState; to: JobState };
    const accepted = cancelRace.acceptedCancellation as { from: JobState; to: JobState };
    expect(cancelRace.state).toBe('cancel-requested');
    // A prior cancellation request masks ordinary completion...
    expect(canTransitionJob(attempted.from, attempted.to)).toBe(false);
    // ...while verified stopping still confirms the cancellation.
    expect(canTransitionJob(accepted.from, accepted.to)).toBe(true);
    // Repeat cancel requests stay idempotent.
    expect(canTransitionJob('cancel-requested', 'cancel-requested')).toBe(true);
  });
});

describe('attempt transitions', () => {
  it('moves claims through preparing into running or stopping', () => {
    expect(canTransitionAttempt('claimed', 'preparing')).toBe(true);
    expect(canTransitionAttempt('preparing', 'running')).toBe(true);
    expect(canTransitionAttempt('running', 'stopping')).toBe(true);
    expect(canTransitionAttempt('running', 'completed')).toBe(true);
  });

  it('forbids direct cancel of running attempts and completion while stopping', () => {
    expect(canTransitionAttempt('running', 'cancelled')).toBe(false);
    expect(canTransitionAttempt('stopping', 'completed')).toBe(false);
    expect(canTransitionAttempt('stopping', 'cancelled')).toBe(true);
    expect(canTransitionAttempt('stopping', 'failed')).toBe(true);
  });

  it('allows unknown-outcome only from active states', () => {
    const active: AttemptState[] = ['claimed', 'preparing', 'running', 'stopping'];
    for (const from of active) {
      expect(canTransitionAttempt(from, 'unknown-outcome')).toBe(true);
    }
    const terminal: AttemptState[] = ['completed', 'failed', 'cancelled', 'unknown-outcome'];
    for (const from of terminal) {
      expect(canTransitionAttempt(from, 'unknown-outcome')).toBe(false);
    }
  });
});

describe('handoff transitions', () => {
  it('walks the full golden sequence forward', () => {
    const states = handoffSequence.states as unknown as HandoffState[];
    expect(states[0]).toBe('requested');
    expect(states[states.length - 1]).toBe('completed');
    for (let index = 0; index < states.length - 1; index += 1) {
      expect(canAdvanceHandoff(states[index], states[index + 1])).toBe(true);
    }
  });

  it('rejects skips and backward moves', () => {
    expect(canAdvanceHandoff('requested', 'completed')).toBe(false);
    expect(canAdvanceHandoff('source-quiescing', 'ownership-transferred')).toBe(false);
    expect(canAdvanceHandoff('target-activating', 'source-quiescing')).toBe(false);
    expect(canAdvanceHandoff('completed', 'cancelled')).toBe(false);
  });

  it('allows cancel and failure from every non-terminal state', () => {
    const nonTerminal: HandoffState[] = [
      'requested',
      'target-prepared-without-execution',
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      'ownership-transferred',
      'target-activating',
    ];
    for (const from of nonTerminal) {
      expect(canAdvanceHandoff(from, 'cancelled')).toBe(true);
      expect(canAdvanceHandoff(from, 'failed')).toBe(true);
    }
  });
});

describe('artifact transitions', () => {
  it('requires verified upload before publish and deleting before deleted', () => {
    expect(canTransitionArtifact('reserved', 'uploaded')).toBe(true);
    expect(canTransitionArtifact('reserved', 'published')).toBe(false);
    expect(canTransitionArtifact('uploaded', 'published')).toBe(true);
    expect(canTransitionArtifact('published', 'deleted')).toBe(false);
    expect(canTransitionArtifact('published', 'deleting')).toBe(true);
    expect(canTransitionArtifact('deleting', 'deleted')).toBe(true);
  });
});
