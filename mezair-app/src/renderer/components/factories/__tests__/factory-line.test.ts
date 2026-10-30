import { describe, expect, it } from 'vitest';
import type {
  FactoryDefinition,
  FactoryDefinitionInput,
  FactoryRun,
} from '../../../../shared/factories';
import {
  definitionIssues,
  formatDuration,
  groupRuns,
  nextStep,
  normalizeDefinition,
  relativeTime,
  runBudgets,
  runPosition,
  stationLoads,
  summarizeRuns,
} from '../factory-line';

const definition: FactoryDefinitionInput = {
  name: 'Ready issues',
  workspaceId: 'ws',
  repoId: 'repo',
  github: { host: 'github.com', owner: 'acme', repo: 'shop', label: 'ready', baseBranch: 'main' },
  workflowTemplateId: 'tpl',
  criteria: ['Tests pass', 'Types pass'],
  checks: ['pnpm test', 'pnpm typecheck'],
  postMergeChecks: ['pnpm test'],
  limits: { repairRounds: 2, maxRunMinutes: 60, maxCommands: 20, maxConcurrentRuns: 2 },
  publication: { enabled: true, draft: true },
  merge: {
    mode: 'human-approved',
    method: 'squash',
    requiredChecks: ['ci'],
    requireApproval: true,
  },
  access: { kind: 'private' },
};

const snapshot = (overrides: Partial<FactoryDefinitionInput> = {}): FactoryDefinition => ({
  id: 'factory',
  workspaceId: 'ws',
  revision: 1,
  status: 'active',
  ownerId: 'me',
  accountScope: 'me',
  definition: { ...definition, ...overrides },
  workflow: {
    id: 'tpl',
    name: 'Graph',
    description: '',
    nodes: [],
    edges: [],
    createdAt: '',
    updatedAt: '',
  },
  confirmation: 'c',
  createdAt: '',
  updatedAt: '',
});

const NOW = Date.parse('2026-10-27T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function run(overrides: Partial<FactoryRun> = {}, definitionOverrides = {}): FactoryRun {
  return {
    id: overrides.id ?? 'run',
    factoryId: 'factory',
    revision: 1,
    workspaceId: 'ws',
    snapshot: snapshot(definitionOverrides),
    issue: {
      number: 1,
      title: 'Issue',
      body: '',
      url: '',
      labels: ['ready'],
      state: 'open',
      createdAt: '',
      updatedAt: '',
    },
    stage: 'implementing',
    version: 1,
    repairRounds: 0,
    commandsUsed: 0,
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(1),
    deadlineAt: '',
    receipts: [],
    ...overrides,
  };
}

describe('runPosition', () => {
  it('maps live stages onto their stations', () => {
    expect(runPosition(run({ stage: 'repairing' }))).toMatchObject({
      station: 'build',
      state: 'live',
    });
    expect(runPosition(run({ stage: 'waiting-checks' }))).toMatchObject({
      station: 'checks',
      state: 'waiting',
    });
    expect(runPosition(run({ stage: 'completed' }))).toMatchObject({
      station: 'done',
      state: 'done',
    });
  });

  it('asks a person to approve only under human-approved merge', () => {
    expect(runPosition(run({ stage: 'awaiting-merge-approval' })).state).toBe('needs-you');
    expect(
      runPosition(
        run(
          { stage: 'awaiting-merge-approval' },
          { merge: { ...definition.merge, mode: 'auto-merge' } },
        ),
      ).state,
    ).toBe('waiting');
  });

  it('keeps blocked and paused runs at the station where they stopped', () => {
    expect(runPosition(run({ stage: 'blocked', resumeStage: 'validating' }))).toMatchObject({
      station: 'verify',
      state: 'blocked',
    });
    expect(runPosition(run({ stage: 'paused', resumeStage: 'waiting-checks' }))).toMatchObject({
      station: 'checks',
      state: 'paused',
    });
  });

  it('infers the stop station from evidence when resumeStage is missing', () => {
    const pr = {
      number: 3,
      url: '',
      headSha: 'a'.repeat(40),
      branch: 'b',
      baseBranch: 'main',
      draft: true,
    };
    expect(runPosition(run({ stage: 'cancelled', pullRequest: pr })).station).toBe('checks');
    expect(runPosition(run({ stage: 'taken-over' })).state).toBe('handed-off');
    expect(runPosition(run({ stage: 'waiting-checks', pendingControl: 'cancel' })).state).toBe(
      'cancelling',
    );
  });
});

describe('board and grouping', () => {
  const runs = [
    run({ id: 'a', stage: 'implementing' }),
    run({ id: 'b', stage: 'awaiting-merge-approval' }),
    run({ id: 'c', stage: 'blocked', resumeStage: 'validating' }),
    run({ id: 'd', stage: 'completed' }),
    run({ id: 'e', stage: 'cancelled' }),
    run({ id: 'f', stage: 'waiting-checks' }),
  ];

  it('counts runs at each station and leaves cancelled work off the line', () => {
    const loads = stationLoads(runs);
    const by = Object.fromEntries(loads.map((load) => [load.station, load]));
    expect(by.build).toMatchObject({ total: 1, live: 1 });
    expect(by.merge).toMatchObject({ total: 1, needsYou: 1 });
    expect(by.verify).toMatchObject({ total: 1, blocked: 1 });
    expect(by.checks).toMatchObject({ total: 1, waiting: 1 });
    expect(by.done.total).toBe(1);
    expect(loads.reduce((sum, load) => sum + load.total, 0)).toBe(5);
  });

  it('groups attention first and orders active work by progress', () => {
    const groups = groupRuns(runs);
    expect(groups.attention.map((item) => item.id).sort()).toEqual(['b', 'c']);
    expect(groups.active.map((item) => item.id)).toEqual(['f', 'a']);
    expect(groups.finished.map((item) => item.id).sort()).toEqual(['d', 'e']);
    expect(summarizeRuns(runs)).toEqual({ active: 4, attention: 2, live: 1 });
  });
});

describe('nextStep', () => {
  it('names the exact head a person approves', () => {
    const step = nextStep(
      run({
        stage: 'awaiting-merge-approval',
        observation: {
          headSha: 'abcdef1234567890',
          state: 'open',
          draft: false,
          checks: [],
          review: 'approved',
          feedback: [],
          observedAt: '',
        },
      }),
    );
    expect(step.title).toBe('Needs your merge approval');
    expect(step.detail).toContain('abcdef1');
  });

  it('summarises required check progress and review state', () => {
    const head = 'f'.repeat(40);
    const step = nextStep(
      run({
        stage: 'waiting-checks',
        observation: {
          headSha: head,
          state: 'open',
          draft: true,
          checks: [
            { name: 'ci', status: 'passed', headSha: head },
            { name: 'lint', status: 'pending', headSha: head },
          ],
          review: 'pending',
          feedback: [],
          observedAt: '',
        },
      }),
    );
    expect(step.detail).toBe('1 of 1 required checks passed, review pending');
  });

  it('explains where a blocked run stopped using its error', () => {
    const step = nextStep(
      run({ stage: 'blocked', resumeStage: 'validating', error: 'Checks failed.' }),
    );
    expect(step).toEqual({ title: 'Blocked at Verify', detail: 'Checks failed.' });
  });
});

describe('runBudgets', () => {
  it('measures consumption against the pinned limits and flags exhaustion', () => {
    const [commands, repairs, time] = runBudgets(
      run({ commandsUsed: 17, repairRounds: 2, createdAt: minutesAgo(30) }),
      NOW,
    );
    expect(commands).toMatchObject({ value: '17 of 20', tone: 'warning' });
    expect(repairs).toMatchObject({ value: '2 of 2', tone: 'exhausted' });
    expect(time).toMatchObject({ value: '30m of 1h', tone: 'normal' });
  });

  it('stops the clock when a run ends', () => {
    const [, , time] = runBudgets(
      run({ stage: 'completed', createdAt: minutesAgo(50), updatedAt: minutesAgo(40) }),
      NOW,
    );
    expect(time.value).toBe('10m of 1h');
  });
});

describe('formatting', () => {
  it('formats relative times and durations compactly', () => {
    expect(relativeTime(minutesAgo(0), NOW)).toBe('just now');
    expect(relativeTime(minutesAgo(5), NOW)).toBe('5m ago');
    expect(relativeTime(minutesAgo(180), NOW)).toBe('3h ago');
    expect(relativeTime(minutesAgo(60 * 72), NOW)).toBe('3d ago');
    expect(formatDuration(95 * 60_000)).toBe('1h 35m');
  });
});

describe('definition editing', () => {
  it('drops empty rows but keeps half-filled pairs so they can be flagged', () => {
    const normalized = normalizeDefinition({
      ...definition,
      criteria: ['Tests pass', '', 'Docs build', ''],
      checks: ['pnpm test', '', '', ''],
      postMergeChecks: [' pnpm test ', ''],
    });
    expect(normalized.criteria).toEqual(['Tests pass', 'Docs build']);
    expect(normalized.checks).toEqual(['pnpm test', '']);
    expect(normalized.postMergeChecks).toEqual(['pnpm test']);
    expect(definitionIssues(normalized).map((issue) => issue.message)).toContain(
      'Every criterion needs its own check command.',
    );
  });

  it('mirrors backend limits and the reserved command budget', () => {
    const messages = definitionIssues({
      ...definition,
      limits: { repairRounds: 9, maxRunMinutes: 0, maxCommands: 3, maxConcurrentRuns: 20 },
    }).map((issue) => issue.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'The command budget needs at least 4 to leave room for implementation and every check.',
        'Repair rounds must be between 0 and 8.',
        'Time per issue must be between 1 and 1440.',
        'Issues at once must be between 1 and 8.',
      ]),
    );
    expect(definitionIssues(definition)).toEqual([]);
    expect(definitionIssues(definition, ['Factory workers must run locally.'])[0]).toEqual({
      field: 'workflow',
      message: 'Factory workers must run locally.',
    });
  });
});
