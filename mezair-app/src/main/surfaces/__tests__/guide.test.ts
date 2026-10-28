import { afterEach, describe, expect, it } from 'vitest';
import {
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { buildSurfaceGuide } from '../guide.js';

const ctx: AgentToolSessionContext = {
  sessionId: 's',
  appThreadId: 't',
  repoIds: [],
  provider: 'codex',
  mode: 'workspace-auto',
  features: [],
};

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

afterEach(() => resetAgentToolProvidersForTests());

describe('buildSurfaceGuide', () => {
  it('builds a concise generic guide with the fence fallback', () => {
    const guide = buildSurfaceGuide();
    expect(wordCount(guide)).toBeLessThan(1100);
    expect(guide).toContain('**Sketch or Artifact?**');
    expect(guide).toContain('only when the user asks');
    expect(guide).toContain('never suggest it automatically');
    expect(guide).toContain('`validation_*`');
    expect(guide).toContain('`review_*`');
    expect(guide).toContain('--mezair-series-1');
    expect(guide).toContain('window.MezairKit');
    expect(guide).toContain('```artifact:');
    expect(guide).toContain('```sketch');
  });

  it('builds the intent table from the tools available to the session', () => {
    registerAgentToolProvider({
      id: 'test',
      tools: () =>
        ['review_context', 'review_publish', 'artifact_create', 'sketch_show', 'surface_read'].map(
          (name) => ({ name, description: name, inputSchema: { type: 'object' } }),
        ),
      call: async () => undefined,
    });
    const guide = buildSurfaceGuide(ctx);
    expect(guide).toContain('`review_context`, `review_publish`');
    expect(guide).toContain('`sketch_show`');
    expect(guide).not.toContain('deps_');
    expect(guide).not.toContain('```artifact:');
    expect(wordCount(guide)).toBeLessThan(1100);
  });

  it('describes only fences when the session has no tools', () => {
    const guide = buildSurfaceGuide(ctx);
    expect(guide).toContain('```artifact:');
    expect(guide).not.toContain('| Intent | Tools |');
  });
});
