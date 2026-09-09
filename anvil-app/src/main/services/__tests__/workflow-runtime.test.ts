import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowNode, WorkflowRun } from '../../../shared/types';
import {
  CONTEXTUAL_WORKFLOW_PRESETS,
  isContextualWorkflowPreset,
  DEFAULT_ORCHESTRATION,
  createOrchestrationPreset,
  parseDelegation,
  validateOrchestration,
} from '../../../shared/workflow-orchestration';
import { expandWorkflowTeam, runWorkflowRuntime, workflowHandoff } from '../workflow-runtime';

function node(id: string): WorkflowNode {
  return {
    id,
    name: id,
    prompt: `Do ${id}`,
    personaId: 'coder',
    provider: 'codex',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    executionStrategy: 'focused',
    position: { x: 400, y: 0 },
  };
}
function run(ids = ['a', 'b', 'c']): WorkflowRun {
  return {
    id: 'run',
    templateId: 'template',
    templateName: 'Test',
    workspaceId: 'workspace',
    repoIds: [],
    nodes: ids.map(node),
    edges: [],
    kickoff: 'Deliver',
    status: 'queued',
    supervisorThreadId: 'supervisor',
    nodeRuns: ids.map((nodeId) => ({ nodeId, status: 'queued' })),
    createdAt: new Date().toISOString(),
    orchestration: {
      ...DEFAULT_ORCHESTRATION,
      maxConcurrency: 2,
      profiles: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          provider: 'openai',
          model: 'gpt-5.6-terra',
          reasoningEffort: 'high',
          personaId: 'coder',
          capabilities: ['review'],
        },
      ],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe('bounded workflow runtime', () => {
  it('fills a freed slot without waiting for an unrelated slow agent', async () => {
    const current = run();
    current.edges = [{ id: 'ac', source: 'a', target: 'c' }];
    const a = deferred<{ output: string }>();
    const b = deferred<{ output: string }>();
    const execute = vi.fn(async (_run, step) =>
      step.id === 'a' ? a.promise : step.id === 'b' ? b.promise : { output: 'c' },
    );
    const completion = runWorkflowRuntime(current, {
      execute,
      persist: vi.fn(),
      signal: new AbortController().signal,
    });
    expect(execute.mock.calls.map((call) => call[1].id)).toEqual(['a', 'b']);
    a.resolve({ output: 'a' });
    await flush();
    expect(execute.mock.calls.map((call) => call[1].id)).toEqual(['a', 'b', 'c']);
    expect(current.nodeRuns.find((state) => state.nodeId === 'b')?.status).toBe('running');
    b.resolve({ output: 'b' });
    await completion;
    expect(current.status).toBe('completed');
  });

  it('never exceeds configured concurrency', async () => {
    const current = run(['a', 'b', 'c', 'd', 'e']);
    let active = 0;
    let maximum = 0;
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: async () => {
        active++;
        maximum = Math.max(active, maximum);
        await flush();
        active--;
        return { output: 'done' };
      },
    });
    expect(maximum).toBe(2);
    expect(current.status).toBe('completed');
  });

  it('runs independent work while skipping descendants of failures', async () => {
    const current = run();
    current.edges = [{ id: 'ac', source: 'a', target: 'c' }];
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: async (_run, step) => {
        if (step.id === 'a') throw new Error('broken');
        return { output: 'done' };
      },
    });
    expect(current.nodeRuns.map((state) => state.status)).toEqual([
      'failed',
      'completed',
      'skipped',
    ]);
    expect(current.nodeRuns[0].attempts?.[0].error).toBe('broken');
    expect(current.status).toBe('failed');
  });

  it('does not resurrect cancellation before dispatch', async () => {
    const current = run();
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    await runWorkflowRuntime(current, { persist: vi.fn(), signal: controller.signal, execute });
    expect(execute).not.toHaveBeenCalled();
    expect(current.status).toBe('cancelled');
  });

  it('ignores late worker success after cancellation', async () => {
    const current = run(['a', 'b']);
    current.orchestration!.maxConcurrency = 1;
    const controller = new AbortController();
    const task = deferred<{ output: string }>();
    const execute = vi.fn(() => task.promise);
    const completion = runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: controller.signal,
      execute,
    });
    current.status = 'cancelled';
    controller.abort();
    task.resolve({ output: 'late success' });
    await completion;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(current.status).toBe('cancelled');
    expect(current.nodeRuns.every((state) => state.status === 'cancelled')).toBe(true);
    expect(current.nodeRuns[0].attempts?.[0].status).toBe('cancelled');
  });

  it('pauses dispatch while preserving an in-flight result', async () => {
    const current = run(['a', 'b']);
    current.orchestration!.maxConcurrency = 1;
    const task = deferred<{ output: string }>();
    const completion = runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: () => task.promise,
    });
    current.status = 'paused';
    task.resolve({ output: 'done' });
    await completion;
    expect(current.nodeRuns.map((state) => state.status)).toEqual(['completed', 'queued']);
    expect(current.status).toBe('paused');
  });

  it('holds downstream work at a human gate without consuming an attempt', async () => {
    const current = run(['decision', 'b']);
    current.nodes[0].kind = 'human';
    current.edges = [{ id: 'db', source: 'decision', target: 'b' }];
    const execute = vi.fn();
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(current.status).toBe('paused');
    expect(current.nodeRuns.map((state) => state.status)).toEqual(['waiting', 'queued']);
  });

  it('enforces the wall-clock budget and stops dispatch', async () => {
    vi.useFakeTimers();
    const current = run(['a', 'b']);
    current.orchestration!.maxConcurrency = 1;
    const completion = runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: (_run, _node, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    await vi.advanceTimersByTimeAsync(30 * 60000);
    await completion;
    expect(current.status).toBe('failed');
    expect(current.error).toContain('wall-clock');
    expect(current.nodeRuns[1].attempts).toBeUndefined();
  });

  it('expands a fixed team and waits for its cross-provider handoff before synthesis', async () => {
    const current = run(['review']);
    current.nodes[0].teamStrategy = 'review';
    current.nodes[0].teamProfileIds = ['reviewer'];
    const visited: WorkflowNode[] = [];
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: async (_run, step) => {
        visited.push(step);
        return { output: `Result ${step.name}` };
      },
    });
    expect(visited).toHaveLength(2);
    expect(visited[0].provider).toBe('openai');
    expect(visited[0].reasoningEffort).toBe('high');
    expect(visited[1].id).toBe('review');
    expect(current.status).toBe('completed');
    expect(workflowHandoff(current, current.nodes[0])).toContain('Result review / Reviewer');
  });

  it('supports autonomous delegation and a fresh parent synthesis attempt', async () => {
    const current = run(['manager']);
    current.nodes[0].teamStrategy = 'autonomous';
    let dispatched = 0;
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: async () => ({
        output:
          dispatched++ === 0
            ? '```anvil-delegate\n{"tasks":[{"profileId":"reviewer","name":"Audit","prompt":"Inspect"}]}\n```'
            : 'done',
      }),
    });
    expect(current.nodes).toHaveLength(2);
    expect(current.nodeRuns[0].attempts).toHaveLength(2);
    expect(current.nodeRuns[1].attempts?.[0].provider).toBe('openai');
    expect(current.status).toBe('completed');
  });

  it('recursively delegates and synthesises each parent in dependency order', async () => {
    const current = run(['manager']);
    current.nodes[0].teamStrategy = 'autonomous';
    const calls: string[] = [];
    const completed = new Set<string>();
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute: async (_run, step) => {
        calls.push(`${step.depth ?? 0}:${step.id}`);
        if ((step.depth ?? 0) < 2 && !completed.has(step.id)) {
          completed.add(step.id);
          return {
            output:
              '```anvil-delegate\n{"tasks":[{"profileId":"reviewer","name":"Nested specialist","prompt":"Inspect independently"}]}\n```',
          };
        }
        return { output: 'Synthesised' };
      },
    });
    expect(calls.map((call) => call.split(':')[0])).toEqual(['0', '1', '2', '1', '0']);
    expect(current.nodes).toHaveLength(3);
    expect(current.status).toBe('completed');
  });

  it('rejects escalation outside the approved pool without partial graph mutation', () => {
    const current = run(['a']);
    expect(() =>
      expandWorkflowTeam(current, current.nodes[0], [
        { profileId: 'reviewer', name: 'ok', prompt: 'ok' },
        { profileId: 'unknown', name: 'bad', prompt: 'bad' },
      ]),
    ).toThrow('not allowed');
    expect(current.nodes).toHaveLength(1);
    expect(current.edges).toHaveLength(0);
  });

  it('enforces depth and total graph limits', () => {
    const current = run(['a']);
    const tasks = [{ profileId: 'reviewer', name: 'review', prompt: 'inspect' }];
    current.nodes[0].depth = 3;
    expect(() => expandWorkflowTeam(current, current.nodes[0], tasks)).toThrow('depth');
    current.nodes[0].depth = 0;
    current.orchestration!.maxNodes = 1;
    expect(() => expandWorkflowTeam(current, current.nodes[0], tasks)).toThrow('node count');
  });

  it('does not automatically repeat exhausted attempts', async () => {
    const current = run(['a']);
    current.orchestration!.maxAttempts = 1;
    current.nodeRuns[0].attempts = [
      {
        id: 'old',
        status: 'failed',
        startedAt: '',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
      },
    ];
    const execute = vi.fn();
    await runWorkflowRuntime(current, {
      persist: vi.fn(),
      signal: new AbortController().signal,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(current.status).toBe('failed');
  });
});

describe('orchestration contracts', () => {
  it('rejects malformed policies and profiles', () => {
    expect(() => validateOrchestration({ ...DEFAULT_ORCHESTRATION, maxConcurrency: NaN })).toThrow(
      'maxConcurrency',
    );
    expect(() => validateOrchestration({ ...DEFAULT_ORCHESTRATION, maxDepth: 7 })).toThrow(
      'maxDepth',
    );
  });
  it('requires a deliberate final delegation block', () => {
    expect(parseDelegation('Some text about {"tasks":[]}')).toBeNull();
    expect(
      parseDelegation('```anvil-delegate\n{"tasks":[]}\n```\nquoted example above'),
    ).toBeNull();
    expect(() => parseDelegation('```anvil-delegate\n{"tasks":[]}\n```')).toThrow();
  });
  it('produces connected delivery and review graphs with human gates', () => {
    const delivery = createOrchestrationPreset('delivery', []);
    expect(delivery.nodes).toHaveLength(4);
    expect(delivery.edges).toHaveLength(3);
    expect(delivery.nodes.at(-1)?.kind).toBe('human');
    validateOrchestration(delivery.orchestration);
    expect(createOrchestrationPreset('review', []).nodes[0].teamStrategy).toBe('review');
  });
});

describe('contextual workflow presets', () => {
  it.each(CONTEXTUAL_WORKFLOW_PRESETS)(
    '%s pauses for a human decision after specialist reconciliation',
    async (kind) => {
      const preset = createOrchestrationPreset(kind, []);
      validateOrchestration(preset.orchestration);
      const current = {
        ...run([]),
        nodes: preset.nodes,
        edges: preset.edges,
        orchestration: preset.orchestration,
        nodeRuns: preset.nodes.map((node) => ({ nodeId: node.id, status: 'queued' as const })),
      };
      const execute = vi.fn(async () => ({ output: 'Agent analysis with missing evidence' }));
      await runWorkflowRuntime(current, {
        execute,
        persist: vi.fn(),
        signal: new AbortController().signal,
      });
      expect(current.status).toBe('paused');
      expect(current.nodeRuns.find((node) => node.nodeId === 'decision')?.status).toBe('waiting');
      expect(execute).toHaveBeenCalled();
      expect(preset.nodes[0].prompt).toContain('Agent narratives never establish verification');
      expect(preset.nodes[0].teamProfileIds).toEqual(
        preset.orchestration?.profiles.map((profile) => profile.id),
      );
    },
  );
  it('accepts only known contextual preset identifiers', () => {
    expect(isContextualWorkflowPreset('pr-review')).toBe(true);
    expect(isContextualWorkflowPreset('unknown')).toBe(false);
    expect(isContextualWorkflowPreset(null)).toBe(false);
  });
});
