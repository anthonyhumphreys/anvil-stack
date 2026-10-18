import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents';
import type { ChatArtifact } from '../../../../shared/types';
import type { ChatEntry } from '../../../contexts/ChatContext';
import { SurfacesContext, type SurfacesContextValue } from '../../surfaces/surfaces-context';
import { buildThreadSurfaceEntries } from '../ChatSurfacesPopover';
import { planProgress } from '../ChatPromptOverlays';
import { composeChatTurns } from '../chat-turns';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  findFenceArtifact,
  parseFenceInfo,
  readFenceLanguage,
  surfaceFenceKind,
} from '../surface-fences';

const artifact = {
  id: 'art-1',
  threadId: 't',
  title: 'Runbook',
  kind: 'markdown',
  storage: 'repository',
  relativePath: 'docs/runbook.md',
  content: '# Runbook',
  version: 2,
  status: 'draft',
  visibility: 'local',
  source: 'assistant',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies ChatArtifact;

function surfaceIntent(id: string, kind = 'review', data: unknown = {}): AgentUISurfaceIntent {
  return {
    protocolVersion: 1,
    id,
    kind: 'surface',
    revision: 1,
    scope: { threadId: 't' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: { surfaceKind: kind, title: `Title ${id}`, streaming: false, digest: 'd', data },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('surface fences', () => {
  it('recognises artifact and sketch languages', () => {
    expect(readFenceLanguage('language-artifact:docs/runbook.md')).toBe('artifact:docs/runbook.md');
    expect(surfaceFenceKind('artifact:docs/runbook.md')).toBe('artifact');
    expect(surfaceFenceKind('artifact')).toBe('artifact');
    expect(surfaceFenceKind('sketch')).toBe('sketch');
    expect(surfaceFenceKind('artifacts')).toBeNull();
    expect(surfaceFenceKind('typescript')).toBeNull();
  });

  it('parses headers and matches the persisted artifact by path, then title', () => {
    const info = parseFenceInfo('artifact:docs/runbook.md', 'kind=markdown title="Short title"');
    expect(info).toEqual({
      relativePath: 'docs/runbook.md',
      kind: 'markdown',
      title: 'Short title',
    });
    expect(parseFenceInfo('artifact', 'path=a/b.md')).toEqual({ relativePath: 'a/b.md' });
    expect(findFenceArtifact([artifact], info)).toBe(artifact);
    expect(findFenceArtifact([artifact], { title: 'Runbook' })).toBe(artifact);
    expect(findFenceArtifact([artifact], { relativePath: 'nope.md' })).toBeUndefined();
  });

  it('never renders artifact or sketch fences as code blocks', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content:
          'Intro\n\n```artifact:docs/runbook.md kind=markdown title="Runbook"\n# Hello\n```\n\n```sketch title="Chart"\n<div>hi</div>\n```\n',
      }),
    );
    expect(markup).toContain('data-artifact-fence');
    expect(markup).toContain('data-sketch-fence');
    expect(markup).toContain('Runbook');
    expect(markup).toContain('Chart');
    expect(markup).not.toContain('data-line-number-gutter');
  });

  it('renders a persisted fence artifact as an inline surface with stage and window controls', () => {
    const context: SurfacesContextValue = {
      threadId: 't',
      workspaceName: 'Workspace',
      surfaces: [],
      artifacts: [artifact],
      resolve: (intent) => intent,
      getSurface: () => undefined,
      stageSurfaceId: null,
      stageTargetId: null,
      readOnly: false,
      isWindowOpen: () => false,
      scrollToSurface: () => undefined,
      openStage: () => undefined,
      openWindow: () => undefined,
    };
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SurfacesContext.Provider,
          { value: context },
          createElement(MarkdownRenderer, {
            content: '```artifact:docs/runbook.md kind=markdown title="Runbook"\n# Runbook\n```\n',
          }),
        ),
      ),
    );
    expect(markup).toContain('data-surface-id="artifact:art-1"');
    expect(markup).toContain('Expand preview');
    expect(markup).toContain('Open in window');
    expect(markup).not.toContain('Not saved to this thread');
  });
});

describe('composeChatTurns surfaces', () => {
  it('lifts surface intents out of the work log into the turn', () => {
    const entries: ChatEntry[] = [
      { kind: 'user', content: 'Review my changes', id: 'u1' },
      {
        kind: 'event',
        event: { type: 'agent_ui_intent', agentUIIntent: surfaceIntent('s1') },
      },
      { kind: 'event', event: { type: 'tool_call', toolName: 'anvil.review_publish' } },
      { kind: 'assistant', content: 'Done.', id: 'a1' },
    ];
    const [turn] = composeChatTurns(entries);
    expect(turn.surfaces.map((surface) => surface.intent.id)).toEqual(['s1']);
    expect(turn.surfaces[0].sourceIndex).toBeLessThan(turn.answer!.sourceIndex);
    expect(
      turn.work.some((item) => item.kind === 'event' && item.event.type === 'agent_ui_intent'),
    ).toBe(false);
  });
});

describe('buildThreadSurfaceEntries', () => {
  it('lists surfaces then artifacts without a surface', () => {
    const covered = surfaceIntent('s-art', 'artifact', {
      artifactId: 'art-1',
      version: 1,
      operation: 'created',
    });
    const entries = buildThreadSurfaceEntries(
      [surfaceIntent('s1'), covered],
      [artifact, { ...artifact, id: 'art-2', title: 'Loose' }],
    );
    expect(entries.map((entry) => entry.id)).toEqual(['s1', 's-art', 'artifact:art-2']);
    expect(entries[1].detail).toBe('Artifact · v1');
    expect(entries[2].inTranscript).toBe(false);
  });
});

describe('planProgress', () => {
  it('counts completed steps for snapshots', () => {
    expect(
      planProgress({
        kind: 'snapshot',
        plan: {
          updatedAt: '',
          steps: [
            { step: 'a', status: 'completed' },
            { step: 'b', status: 'in_progress' },
          ],
        },
      }),
    ).toEqual({ done: 1, total: 2, title: 'Implementation plan' });
  });
});
