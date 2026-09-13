import { describe, expect, it } from 'vitest';
import { runBootstrapRecipe } from '../bootstrap-runner.service';
import type {
  BootstrapRecipe,
  BootstrapStepState,
} from '../../../../cloud/contract/bootstrap';

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
      recipe([
        nodeStep('bad', 'process.exit(3)'),
        nodeStep('never', 'console.log("unreachable")'),
      ]),
      { checkoutRoot: '/tmp' },
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
      { checkoutRoot: '/tmp' },
    ).done;
    expect(result.state).toBe('unknown-outcome');
    expect(result.steps[0].timedOut).toBe(true);
  });

  it('cancel() terminates the in-flight process group', async () => {
    const handle = runBootstrapRecipe(
      recipe([nodeStep('sleep', 'setTimeout(() => {}, 60000)')]),
      { checkoutRoot: '/tmp' },
    );
    setTimeout(() => handle.cancel(), 50);
    const result = await handle.done;
    expect(result.state).toBe('unknown-outcome');
    expect(result.steps[0].state).toBe('unknown-outcome');
  });

  it('forwards live log chunks to the observer sink', async () => {
    const chunks: string[] = [];
    const result = await runBootstrapRecipe(
      recipe([nodeStep('logs', 'console.log("a"); console.error("b")')]),
      { checkoutRoot: '/tmp', onStepLog: (_id, chunk) => chunks.push(chunk) },
    ).done;
    expect(result.state).toBe('verified');
    expect(chunks.join('')).toContain('a');
    expect(chunks.join('')).toContain('b');
  });
});
