import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents';
import { SurfaceHost } from '../SurfaceHost';
import { SurfacesContext, type SurfacesContextValue } from '../surfaces-context';

function intent(overrides: Partial<AgentUISurfaceIntent['payload']> = {}): AgentUISurfaceIntent {
  return {
    protocolVersion: 1,
    id: 'surface:1',
    kind: 'surface',
    revision: 2,
    scope: { threadId: 't' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'unknown-kind',
      title: 'Dependency audit',
      streaming: false,
      digest: '3 critical advisories',
      data: { rows: [1] },
      ...overrides,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function render(value: AgentUISurfaceIntent, context: Partial<SurfacesContextValue> = {}) {
  const base: SurfacesContextValue = {
    threadId: 't',
    workspaceName: 'Payments',
    surfaces: [],
    artifacts: [],
    resolve: (item) => item,
    getSurface: () => undefined,
    stageSurfaceId: null,
    stageTargetId: null,
    readOnly: false,
    isWindowOpen: () => false,
    scrollToSurface: () => undefined,
    openStage: () => undefined,
    openWindow: () => undefined,
    ...context,
  };
  return renderToStaticMarkup(
    createElement(
      SurfacesContext.Provider,
      { value: base },
      createElement(SurfaceHost, { intent: value }),
    ),
  );
}

describe('SurfaceHost', () => {
  it('renders the shared chrome with labelled controls and a digest fallback', () => {
    const markup = render(intent());
    expect(markup).toContain('data-surface-id="surface:1"');
    expect(markup).toContain('data-surface-handle');
    expect(markup).toContain('Dependency audit');
    expect(markup).toContain('v2');
    expect(markup).toContain('aria-label="Expand preview"');
    expect(markup).toContain('aria-label="Open in window"');
    expect(markup).toContain('aria-label="More output actions"');
    expect(markup).toContain('3 critical advisories');
  });

  it('collapses superseded surfaces to one line', () => {
    const markup = render(intent({ supersededBy: 'surface:2' }));
    expect(markup).toContain('Updated version below');
    expect(markup).not.toContain('Expand preview');
  });

  it('shows a skeleton while streaming with no data yet', () => {
    const markup = render(intent({ streaming: true, data: {} }));
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('The agent is preparing this output');
  });

  it('offers bring-to-front while a window is open', () => {
    const markup = render(intent(), { isWindowOpen: () => true, focusWindow: () => undefined });
    expect(markup).toContain('Open in window');
    expect(markup).toContain('Bring to front');
    expect(markup).not.toContain('3 critical advisories');
  });

  it('offers minimise, and folds to the header when the intent or the user asks', () => {
    const open = render(intent());
    expect(open).toContain('aria-label="Minimise"');
    expect(open).toContain('aria-expanded="true"');

    const hinted = intent();
    hinted.presentation = { collapsed: true, hidden: false };
    const folded = render(hinted);
    expect(folded).toContain('aria-label="Restore"');
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toMatch(/<div id="[^"]+" hidden="">/);
    expect(folded).toContain('Dependency audit');

    const storage = new Map([['anvil:surface-minimised:surface:1', 'true']]);
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    });
    try {
      expect(render(intent())).toContain('aria-label="Restore"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prefers the newer copy from context', () => {
    const newer = { ...intent({ title: 'Audit v5' }), revision: 5 };
    const markup = render(intent(), { resolve: () => newer });
    expect(markup).toContain('Audit v5');
  });
});
