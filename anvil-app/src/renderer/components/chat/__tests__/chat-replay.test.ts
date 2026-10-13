import { describe, expect, it } from 'vitest';
import type { CodexSession } from '../../../../shared/types';
import { chatMessagesToEntries } from '../../../contexts/ChatContext';
import { buildExecutionTopology } from '../../../utils/execution-topology';
import { composeChatTurns } from '../chat-turns';
import {
  CHAT_REPLAY_PROVENANCE,
  CHAT_REPLAY_SCENARIOS,
  getChatReplayScenario,
  syntheticFollowUpMessage,
  syntheticFollowUpResult,
} from '../replay/chat-replay-fixtures';
import { replayChatScenario } from '../replay/chat-replay-state';
import {
  HEAVY_SURFACE_COUNT,
  REPLAY_REVIEW_DIFF_FILES,
  REPLAY_SURFACE_ARTIFACTS,
  REPLAY_SURFACE_ARTIFACT_REVISIONS,
  REPLAY_SURFACE_SKETCHES,
  SURFACE_REPLAY_SCENARIOS,
} from '../replay/chat-replay-surface-fixtures';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents';
import { validateDataSurface, type DataSurfaceData } from '../../../../shared/surfaces/kinds/data';
import type { ReviewSurfaceData } from '../../../../shared/surfaces/kinds/review';
import { checkLineAnchor, findDiffFile } from '../../../../shared/surfaces/kinds/review/diff';
import { isDecisionConsistent } from '../../../../shared/surfaces/kinds/review/model';
import { getSurfaceKind } from '../../../../shared/surfaces/registry';
import { formatSchemaErrors, validateJsonSchema } from '../../../../shared/surfaces/validate';
import { resolveSupersedingId } from '../../surfaces/surface-utils';

function completeTurns(scenarioId: string) {
  const scenario = getChatReplayScenario(scenarioId);
  const snapshot = replayChatScenario(scenario);
  return composeChatTurns(
    chatMessagesToEntries(snapshot.messagesByThread[scenario.initialThreadId]),
  );
}

function turnsAt(scenarioId: string, step: number) {
  const scenario = getChatReplayScenario(scenarioId);
  const snapshot = replayChatScenario(scenario, step);
  return composeChatTurns(
    chatMessagesToEntries(snapshot.messagesByThread[scenario.initialThreadId]),
    { active: true },
  );
}

function surfacesOf(turns: ReturnType<typeof composeChatTurns>): AgentUISurfaceIntent[] {
  return turns.flatMap((turn) => turn.surfaces.map((surface) => surface.intent));
}

/** Every surface intent published anywhere in a scenario, including streaming revisions. */
function everyPublishedSurface(): AgentUISurfaceIntent[] {
  return SURFACE_REPLAY_SCENARIOS.flatMap((scenario) =>
    scenario.steps.flatMap((step) => {
      const messages =
        step.kind === 'message' ? [step.message] : step.kind === 'history' ? step.messages : [];
      return messages.flatMap((message) =>
        message.event?.type === 'agent_ui_intent' && message.event.agentUIIntent?.kind === 'surface'
          ? [message.event.agentUIIntent]
          : [],
      );
    }),
  );
}

describe('synthetic chat replay scenarios', () => {
  it('labels the fixture data synthetic and contains the required interaction scenarios', () => {
    expect(CHAT_REPLAY_PROVENANCE).toContain('Synthetic');
    expect(CHAT_REPLAY_SCENARIOS.map(({ id }) => id)).toEqual([
      'streaming-rich-content',
      'parallel-agents-status',
      'errors-reconnect-thread-switch',
      'artifact-diff-feedback',
      'large-transcript',
      'surface-review-working-tree',
      'surface-findings',
      'surface-dependencies',
      'surface-pipeline',
      'surface-data-chart',
      'surface-artifact-revisions',
      'surface-sketch',
      'surface-heavy-thread',
    ]);
  });

  it('runs partial markdown, code, and Mermaid chunks through production history and turn derivation', () => {
    const scenario = getChatReplayScenario('streaming-rich-content');
    const partialMarkdown = replayChatScenario(scenario, 2);
    const markdownEntries = chatMessagesToEntries(
      partialMarkdown.messagesByThread[scenario.initialThreadId],
    );
    const markdownTurn = composeChatTurns(markdownEntries, { active: true })[0];

    expect(markdownTurn.answer?.content).toContain('while the next fragment arrives.');
    expect(markdownTurn.answer?.content).not.toContain('flowchart LR');

    const partialCode = replayChatScenario(scenario, 3);
    const codeEntries = chatMessagesToEntries(
      partialCode.messagesByThread[scenario.initialThreadId],
    );
    const code = composeChatTurns(codeEntries, { active: true })[0].answer?.content ?? '';
    expect(code).toContain('```ts');
    expect(code).not.toContain('The closing fence has now arrived.');

    const completeCode = replayChatScenario(scenario, 4);
    const completeCodeEntries = chatMessagesToEntries(
      completeCode.messagesByThread[scenario.initialThreadId],
    );
    expect(composeChatTurns(completeCodeEntries, { active: true })[0].answer?.content).toContain(
      'The closing fence has now arrived.',
    );

    const partialMermaid = replayChatScenario(scenario, 5);
    const mermaidEntries = chatMessagesToEntries(
      partialMermaid.messagesByThread[scenario.initialThreadId],
    );
    const mermaid = composeChatTurns(mermaidEntries, { active: true })[0].answer?.content ?? '';
    expect(mermaid).toContain('```mermaid\nflowchart LR');
    expect(mermaid).not.toContain('Visible answer');

    const completed = replayChatScenario(scenario);
    const completedEntries = chatMessagesToEntries(
      completed.messagesByThread[scenario.initialThreadId],
    );
    expect(composeChatTurns(completedEntries, { active: true })[0].answer?.content).toContain(
      'Visible answer',
    );
  });

  it('derives parallel agent state and completion through the production execution topology', () => {
    const scenario = getChatReplayScenario('parallel-agents-status');
    const session: CodexSession = {
      id: 'fixture-main-session',
      personaId: 'coder',
      status: 'busy',
      startedAt: '2026-09-25T08:59:00.000Z',
      appThreadId: scenario.initialThreadId,
      providerThreadId: 'fixture-main-protocol',
    };
    const runningSnapshot = replayChatScenario(scenario, 2);
    const runningEntries = chatMessagesToEntries(
      runningSnapshot.messagesByThread[scenario.initialThreadId],
    );
    const runningTopology = buildExecutionTopology({
      entries: runningEntries,
      sessions: [session],
      threadId: scenario.initialThreadId,
      rootLabel: 'Synthetic main agent',
    });

    expect(runningTopology.runningCount).toBe(3);
    expect(runningTopology.nodes.filter(({ kind }) => kind === 'subagent')).toHaveLength(2);
    expect(
      runningTopology.nodes
        .filter(({ kind }) => kind === 'subagent')
        .every(({ status }) => status === 'running'),
    ).toBe(true);

    const completedSnapshot = replayChatScenario(scenario);
    const completedEntries = chatMessagesToEntries(
      completedSnapshot.messagesByThread[scenario.initialThreadId],
    );
    const completedTopology = buildExecutionTopology({
      entries: completedEntries,
      sessions: [{ ...session, status: 'ready' }],
      threadId: scenario.initialThreadId,
      rootLabel: 'Synthetic main agent',
    });
    expect(completedTopology.runningCount).toBe(0);
    expect(
      completedTopology.nodes
        .filter(({ kind }) => kind === 'subagent')
        .every(({ status }) => status === 'completed'),
    ).toBe(true);
  });

  it('keeps errors and reconnect state thread-scoped through replay and transcript derivation', () => {
    const scenario = getChatReplayScenario('errors-reconnect-thread-switch');
    const interrupted = replayChatScenario(scenario, 2);
    const interruptedEntries = chatMessagesToEntries(
      interrupted.messagesByThread[scenario.initialThreadId],
    );

    expect(interrupted.transportByThread[scenario.initialThreadId]).toMatchObject({
      state: 'reconnecting',
    });
    expect(
      composeChatTurns(interruptedEntries)[0].work.some(
        (item) => item.kind === 'event' && item.event.type === 'error',
      ),
    ).toBe(true);

    const switched = replayChatScenario(scenario, 5);
    expect(switched.activeThreadId).toBe('fixture-switched');
    expect(switched.messagesByThread['fixture-switched']).toHaveLength(2);
    expect(switched.messagesByThread[scenario.initialThreadId]).toHaveLength(2);

    const reconnected = replayChatScenario(scenario);
    expect(reconnected.activeThreadId).toBe(scenario.initialThreadId);
    expect(reconnected.transportByThread[scenario.initialThreadId]).toMatchObject({
      state: 'connected',
      detail: 'Synthetic connection restored',
    });
    expect(reconnected.messagesByThread[scenario.initialThreadId]).toHaveLength(3);
    expect(reconnected.messagesByThread['fixture-switched']).toHaveLength(2);
  });

  it('derives the two synthetic revision diffs through production turn composition', () => {
    const scenario = getChatReplayScenario('artifact-diff-feedback');
    const snapshot = replayChatScenario(scenario);
    const entries = chatMessagesToEntries(snapshot.messagesByThread[scenario.initialThreadId]);
    const turn = composeChatTurns(entries)[0];
    const edits = turn.work.filter(
      (item) => item.kind === 'event' && item.event.type === 'file_edit',
    );

    expect(edits).toHaveLength(2);
    expect(edits.map((item) => (item.kind === 'event' ? item.event.filePath : '')).sort()).toEqual([
      '/synthetic/anvil-demo/docs/retry.md',
      '/synthetic/anvil-demo/src/retry.ts',
    ]);
    expect(
      edits.every(
        (item) =>
          item.kind === 'event' &&
          item.event.type === 'file_edit' &&
          typeof item.event.diff === 'string' &&
          item.event.diff.includes('diff --git'),
      ),
    ).toBe(true);
  });

  it('provides a deterministic 600-message transcript for long-history derivation', () => {
    const scenario = getChatReplayScenario('large-transcript');
    const snapshot = replayChatScenario(scenario);
    const messages = snapshot.messagesByThread[scenario.initialThreadId];
    const entries = chatMessagesToEntries(messages);
    const turns = composeChatTurns(entries);

    expect(messages).toHaveLength(600);
    expect(turns).toHaveLength(300);
    expect(turns[0].user?.content).toContain('Turn 1');
    expect(turns[299].answer?.content).toContain('Turn 300');
    expect(turns[249].answer?.content).toContain('```mermaid');
    expect(turns[289].answer?.content).toContain('```ts');
  });

  it('returns local guide, queue, and rejection fixtures without provider calls', () => {
    const guide = syntheticFollowUpResult('guide', 'synthetic-guide-1', 1);
    const queued = syntheticFollowUpResult('queue', 'synthetic-queue-1', 2);
    const rejected = syntheticFollowUpResult('queue', 'synthetic-queue-3', 3);

    expect(guide).toEqual({
      requestId: 'synthetic-guide-1',
      intent: 'guide',
      status: 'delivered',
      queueDepth: 0,
    });
    expect(queued).toEqual({
      requestId: 'synthetic-queue-1',
      intent: 'queue',
      status: 'queued',
      queueDepth: 1,
    });
    expect(rejected).toMatchObject({
      requestId: 'synthetic-queue-3',
      status: 'failed',
      queueDepth: 0,
      error: 'Synthetic follow-up rejection. The draft stays local.',
    });

    const queuedMessage = syntheticFollowUpMessage(
      'fixture-agents',
      'Keep the task moving after the current review.',
      undefined,
      queued,
    );
    expect(chatMessagesToEntries([queuedMessage])[0]).toMatchObject({
      kind: 'user',
      requestId: 'synthetic-queue-1',
      delivery: 'queued',
      deliveryIntent: 'queue',
    });
  });
});

describe('inline surface replay fixtures', () => {
  it('validates every published surface payload against its kind schema and digest', async () => {
    expect(validateJsonSchema({ type: 'object', required: ['x'] }, {})).not.toEqual([]);
    const published = everyPublishedSurface();
    expect(published.length).toBeGreaterThan(HEAVY_SURFACE_COUNT);
    for (const intent of published) {
      const definition = getSurfaceKind(intent.payload.surfaceKind);
      expect(definition, intent.payload.surfaceKind).toBeDefined();
      const errors = validateJsonSchema(definition!.schema, intent.payload.data);
      expect(errors, `${intent.id}: ${formatSchemaErrors(errors)}`).toEqual([]);
      expect(intent.payload.digest).toBe(definition!.digest(intent.payload.data));
      expect(intent.scope.threadId).toBeTruthy();
      if (intent.payload.surfaceKind === 'data') {
        expect(validateDataSurface(intent.payload.data as DataSurfaceData)).toEqual([]);
      }
    }
  });

  it('streams the working-tree Review in place, then completes with anchored findings', () => {
    const streaming = surfacesOf(turnsAt('surface-review-working-tree', 2));
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ revision: 1, payload: { streaming: true } });
    expect((streaming[0].payload.data as ReviewSurfaceData).findings).toHaveLength(1);

    const midway = surfacesOf(turnsAt('surface-review-working-tree', 3));
    expect(midway).toHaveLength(1);
    expect(midway[0]).toMatchObject({ revision: 2, payload: { streaming: true } });

    const turns = completeTurns('surface-review-working-tree');
    expect(turns).toHaveLength(1);
    const [review] = surfacesOf(turns);
    expect(turns[0].surfaces).toHaveLength(1);
    expect(review).toMatchObject({
      id: 'fixture-surface-review-working-tree',
      revision: 3,
      payload: { surfaceKind: 'review', streaming: false },
    });
    expect(turns[0].answer?.content).toContain('logged refresh token');
    expect(
      turns[0].work.some(
        (item) => item.kind === 'event' && item.event.toolName === 'review_context',
      ),
    ).toBe(true);

    const data = review.payload.data as ReviewSurfaceData;
    expect(data.scope.type).toBe('working-tree');
    expect(data.findings.length).toBeGreaterThanOrEqual(6);
    expect(data.findings.length).toBeLessThanOrEqual(9);
    expect(new Set(data.findings.map((finding) => finding.severity))).toEqual(
      new Set(['critical', 'high', 'medium', 'low', 'info']),
    );
    expect(data.chapters.map((chapter) => chapter.index)).toEqual([1, 2, 3]);
    expect(data.risks.length).toBeGreaterThan(0);
    expect(isDecisionConsistent(data.verdict.decision, data.findings)).toBe(true);
    for (const finding of data.findings) {
      const file = findDiffFile(REPLAY_REVIEW_DIFF_FILES, finding.filePath);
      expect(file, finding.filePath).toBeDefined();
      expect(checkLineAnchor(file!, finding.lineStart, finding.lineEnd), finding.id).toBeNull();
      expect(data.hunks[finding.filePath]?.length, finding.id).toBeGreaterThan(0);
    }
    for (const chapter of data.chapters) {
      for (const file of chapter.files) {
        expect(data.files.some((entry) => entry.path === file.path)).toBe(true);
      }
    }
  });

  it.each([
    ['surface-findings', 'findings'],
    ['surface-dependencies', 'dependencies'],
    ['surface-pipeline', 'pipeline'],
    ['surface-data-chart', 'data'],
    ['surface-sketch', 'sketch'],
  ])('composes %s into one turn with a %s surface', (scenarioId, kind) => {
    const turns = completeTurns(scenarioId);
    expect(turns).toHaveLength(1);
    expect(turns[0].surfaces.map((surface) => surface.intent.payload.surfaceKind)).toEqual([kind]);
    expect(turns[0].answer?.content).toBeTruthy();
  });

  it('completes the running security audit in place', () => {
    const running = surfacesOf(turnsAt('surface-findings', 1));
    expect(running[0].payload).toMatchObject({ streaming: true, data: { auditStatus: 'running' } });
    const [complete] = surfacesOf(completeTurns('surface-findings'));
    expect(complete).toMatchObject({
      revision: 2,
      payload: { streaming: false, data: { auditStatus: 'completed' } },
    });
  });

  it('charts the data surface from numeric columns', () => {
    const [surface] = surfacesOf(completeTurns('surface-data-chart'));
    const data = surface.payload.data as DataSurfaceData;
    expect(data.chart).toMatchObject({ type: 'line', x: 'week', y: ['p50', 'p95'] });
    expect(data.rows).toHaveLength(12);
  });

  it('supersedes the created artifact surface with the updated one', () => {
    const turns = completeTurns('surface-artifact-revisions');
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.surfaces.length)).toEqual([1, 1]);
    const all = surfacesOf(turns);
    const [created, updated] = all;
    expect(created.payload.data).toMatchObject({ version: 1, operation: 'created' });
    expect(updated.payload.data).toMatchObject({ version: 2, operation: 'updated' });
    expect(resolveSupersedingId(created, all)).toBe(updated.id);
    expect(resolveSupersedingId(updated, all)).toBeUndefined();

    const artifactId = (created.payload.data as { artifactId: string }).artifactId;
    expect(REPLAY_SURFACE_ARTIFACTS.find((item) => item.id === artifactId)?.version).toBe(2);
    expect(
      REPLAY_SURFACE_ARTIFACT_REVISIONS.filter(
        (revision) => revision.artifactId === artifactId,
      ).map((revision) => revision.version),
    ).toEqual([1, 2]);
  });

  it('backs the sketch surface with self-contained, token-themed HTML', () => {
    const [surface] = surfacesOf(completeTurns('surface-sketch'));
    const sketchId = (surface.payload.data as { sketchId: string }).sketchId;
    const sketch = REPLAY_SURFACE_SKETCHES.find((item) => item.id === sketchId);
    expect(sketch?.html).toContain('var(--anvil-');
    expect(sketch?.html).not.toMatch(/<script|https?:\/\//i);
  });

  it('provides a 30-surface heavy thread where every surface stays live', () => {
    const turns = completeTurns('surface-heavy-thread');
    const surfaces = surfacesOf(turns);
    expect(turns).toHaveLength(HEAVY_SURFACE_COUNT / 2);
    expect(surfaces).toHaveLength(HEAVY_SURFACE_COUNT);
    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(HEAVY_SURFACE_COUNT);
    expect(new Set(surfaces.map((surface) => surface.payload.surfaceKind))).toEqual(
      new Set(['review', 'findings', 'data', 'pipeline', 'dependencies', 'artifact', 'sketch']),
    );
    expect(surfaces.every((surface) => !resolveSupersedingId(surface, surfaces))).toBe(true);
  });
});
