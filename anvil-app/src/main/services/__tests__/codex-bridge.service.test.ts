import { describe, expect, it } from 'vitest';
import { readTomlAgentsMaxThreads, updateTomlAgentsMaxThreads } from '../codex-bridge.service';

describe('Codex agent configuration', () => {
  it('reads max_threads only from the agents section', () => {
    const config =
      'max_threads = 99\n\n[agents]\nmax_threads = 8\n\n[features]\nmulti_agent = true\n';
    expect(readTomlAgentsMaxThreads(config)).toBe(8);
  });

  it('adds an agents section while preserving existing config', () => {
    const config = 'model = "gpt-5.6"\n';
    expect(updateTomlAgentsMaxThreads(config, 6)).toBe(
      'model = "gpt-5.6"\n\n[agents]\nmax_threads = 6\n',
    );
  });

  it('updates max_threads without changing the rest of the section', () => {
    const config =
      '[agents]\nmax_threads = 4 # keep this comment\nmax_depth = 2\n\n[features]\nmulti_agent = true\n';
    const updated = updateTomlAgentsMaxThreads(config, 12);
    expect(updated).toContain('max_threads = 12 # keep this comment');
    expect(updated).toContain('max_depth = 2');
    expect(updated).toContain('[features]\nmulti_agent = true');
  });

  it('rejects values outside the supported range', () => {
    expect(() => updateTomlAgentsMaxThreads('', 0)).toThrow('between 1 and 64');
    expect(() => updateTomlAgentsMaxThreads('', 65)).toThrow('between 1 and 64');
    expect(() => updateTomlAgentsMaxThreads('', 1.5)).toThrow('between 1 and 64');
  });
});
