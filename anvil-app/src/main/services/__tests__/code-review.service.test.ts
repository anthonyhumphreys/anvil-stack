import { describe, expect, it } from 'vitest';
import type { CodeReviewVerification } from '../../../shared/types.js';
import {
  buildVerificationExceptionResult,
  buildVerificationFindings,
} from '../code-review.service.js';

describe('buildVerificationFindings', () => {
  it('creates a major finding for failed verification steps', () => {
    const verification: CodeReviewVerification = {
      status: 'failed',
      summary: 'Ran 1 branch-local verification command; 1 failed.',
      worktreePath: '/tmp/anvil-review',
      worktreeKept: true,
      steps: [
        {
          label: 'npm test',
          command: 'npm test',
          status: 'failed',
          exitCode: 1,
          durationMs: 1234,
          outputSnippet: 'Expected true to be false. A classic.',
        },
      ],
    };

    const findings = buildVerificationFindings(verification);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'major',
      category: 'Verification',
    });
    expect(findings[0]?.description).toContain('npm test');
    expect(findings[0]?.description).toContain('exit code 1');
    expect(findings[0]?.suggestion).toContain('/tmp/anvil-review');
    expect(findings[0]?.suggestion).toContain('Expected true to be false');
  });

  it('does not create findings when verification passed or did not run', () => {
    expect(
      buildVerificationFindings({
        status: 'passed',
        summary: 'All passed.',
        steps: [],
      }),
    ).toEqual([]);

    expect(
      buildVerificationFindings({
        status: 'not_run',
        summary: 'No commands found.',
        steps: [],
      }),
    ).toEqual([]);
  });
});

describe('buildVerificationExceptionResult', () => {
  it('converts unexpected verification exceptions into failed verification state', () => {
    const verification = buildVerificationExceptionResult(new Error('spawn exploded'));

    expect(verification.status).toBe('failed');
    expect(verification.summary).toContain('code review continued');
    expect(verification.steps[0]).toMatchObject({
      label: 'verification runner',
      command: 'run branch-local verification',
      status: 'failed',
      outputSnippet: 'spawn exploded',
    });
  });
});
