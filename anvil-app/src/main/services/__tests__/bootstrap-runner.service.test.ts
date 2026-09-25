import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBootstrapRecipe } from '../bootstrap-runner.service';
import type { BootstrapRecipe, BootstrapStepState } from '../../../../cloud/contract/bootstrap';

function recipe(steps: BootstrapRecipe['steps']): BootstrapRecipe {
  return { schemaVersion: 1, steps };
}

function nodeStep(id: string, script: string): BootstrapRecipe['steps'][number] {
  return {
    id,
    kind: 'command',
    workingDirectory: '.',
    argv: [process.execPath, '-e', script],
    timeoutMs: 10_000,
    envNames: [],
    retry: 'safe',
  };
}

describe('bootstrap runner', () => {
  it('runs ordered steps to verified and captures bounded logs', async () => {
    const transitions: Array<[string, BootstrapStepState]> = [];
    const result = await runBootstrapRecipe(
      recipe([
        nodeStep('one', 'console.log("hello-one")'),
        nodeStep('two', 'console.log("hello-two")'),
      ]),
      {
        checkoutRoot: '/tmp',
        shellApproved: true,
        onStepState: (id, state) => transitions.push([id, state]),
      },
    ).done;

    expect(result.state).toBe('verified');
    expect(result.steps.map((s) => s.state)).toEqual(['verified', 'verified']);
    expect(result.steps[0].log).toContain('hello-one');
    expect(transitions).toEqual([
      ['one', 'running'],
      ['one', 'verified'],
      ['two', 'running'],
      ['two', 'verified'],
    ]);
  });

  it('stops at the first failure — later steps never run', async () => {
    const result = await runBootstrapRecipe(
      recipe([nodeStep('bad', 'process.exit(3)'), nodeStep('never', 'console.log("unreachable")')]),
      { checkoutRoot: '/tmp', shellApproved: true },
    ).done;
    expect(result.state).toBe('failed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].exitCode).toBe(3);
  });

  it('strips ambient env and supplies only declared bindings', async () => {
    process.env.ANVIL_TEST_SECRET = 'leak-me';
    const result = await runBootstrapRecipe(
      recipe([
        {
          ...nodeStep(
            'env',
            'console.log([process.env.ANVIL_TEST_SECRET, process.env.MY_BINDING].join("|"))',
          ),
          envNames: ['MY_BINDING'],
        },
      ]),
      {
        checkoutRoot: '/tmp',
        shellApproved: true,
        resolveEnv: (name) => (name === 'MY_BINDING' ? 'bound-value' : undefined),
      },
    ).done;
    // join() renders the stripped var as empty: the log is '|bound-value',
    // proving both that MY_BINDING arrived and the secret did not.
    expect(result.steps[0].log.trim()).toBe('|bound-value');
    expect(result.steps[0].log).not.toContain('leak-me');
    delete process.env.ANVIL_TEST_SECRET;
  });

  it('refuses a shell step without explicit approval', async () => {
    const result = await runBootstrapRecipe(
      recipe([
        {
          id: 'sh',
          kind: 'command',
          workingDirectory: '.',
          shell: 'echo hi',
          timeoutMs: 5_000,
          envNames: [],
          retry: 'safe',
        },
      ]),
      { checkoutRoot: '/tmp' },
    ).done;
    expect(result.state).toBe('failed');
    expect(result.steps[0].log).toContain('no explicit shell approval');
  });

  it('requires local code consent for every argv command', async () => {
    const commands = [
      { id: 'osascript', argv: ['osascript', '-e', 'do shell script "echo unsafe"'] },
      { id: 'package-manager', argv: ['pnpm', 'install'] },
      { id: 'ordinary-argv', argv: ['echo', 'ordinary argv command'] },
    ];
    for (const command of commands) {
      const result = await runBootstrapRecipe(
        recipe([
          {
            ...nodeStep(command.id, 'process.exit(0)'),
            argv: command.argv,
          },
        ]),
        { checkoutRoot: '/tmp' },
      ).done;
      expect(result.state).toBe('failed');
      expect(result.steps[0].log).toContain('argv step without explicit local code approval');
    }
  });

  it('refuses a lexical working directory escape before spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-bootstrap-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'anvil-bootstrap-outside-'));
    try {
      const result = await runBootstrapRecipe(
        recipe([
          {
            ...nodeStep('escape', 'process.exit(0)'),
            workingDirectory: `../${basename(outside)}`,
          },
        ]),
        { checkoutRoot: root, shellApproved: true },
      ).done;
      expect(result.state).toBe('failed');
      expect(result.steps[0].log).toContain('must be relative to the checkout root');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked working directory escape',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'anvil-bootstrap-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'anvil-bootstrap-outside-'));
      try {
        symlinkSync(outside, join(root, 'outside-link'), 'dir');
        const result = await runBootstrapRecipe(
          recipe([
            {
              ...nodeStep('escape', 'process.exit(0)'),
              workingDirectory: 'outside-link',
            },
          ]),
          { checkoutRoot: root, shellApproved: true },
        ).done;
        expect(result.state).toBe('failed');
        expect(result.steps[0].log).toContain('resolves outside the checkout root');
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('runs an approved shell step', async () => {
    const result = await runBootstrapRecipe(
      recipe([
        {
          id: 'sh',
          kind: 'command',
          workingDirectory: '.',
          shell: 'echo shell-ok',
          timeoutMs: 5_000,
          envNames: [],
          retry: 'safe',
        },
      ]),
      { checkoutRoot: '/tmp', shellApproved: true },
    ).done;
    expect(result.state).toBe('verified');
    expect(result.steps[0].log).toContain('shell-ok');
  });

  it('marks a timed-out step unknown-outcome, not failed', async () => {
    const result = await runBootstrapRecipe(
      recipe([
        {
          ...nodeStep('hang', 'setTimeout(() => {}, 60000)'),
          timeoutMs: 150,
        },
      ]),
      { checkoutRoot: '/tmp', shellApproved: true },
    ).done;
    expect(result.state).toBe('unknown-outcome');
    expect(result.steps[0].timedOut).toBe(true);
  });

  it('cancel() terminates the in-flight process group', async () => {
    const handle = runBootstrapRecipe(recipe([nodeStep('sleep', 'setTimeout(() => {}, 60000)')]), {
      checkoutRoot: '/tmp',
      shellApproved: true,
    });
    setTimeout(() => handle.cancel(), 50);
    const result = await handle.done;
    expect(result.state).toBe('unknown-outcome');
    expect(result.steps[0].state).toBe('unknown-outcome');
  });

  it('forwards live log chunks to the observer sink', async () => {
    const chunks: string[] = [];
    const result = await runBootstrapRecipe(
      recipe([nodeStep('logs', 'console.log("a"); console.error("b")')]),
      { checkoutRoot: '/tmp', shellApproved: true, onStepLog: (_id, chunk) => chunks.push(chunk) },
    ).done;
    expect(result.state).toBe('verified');
    expect(chunks.join('')).toContain('a');
    expect(chunks.join('')).toContain('b');
  });
});
