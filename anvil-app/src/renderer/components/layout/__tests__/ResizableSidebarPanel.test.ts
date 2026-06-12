import { describe, expect, it } from 'vitest';
import { shouldAutoCollapsePanel } from '../ResizableSidebarPanel';

describe('shouldAutoCollapsePanel', () => {
  it('auto-collapses below the threshold when the panel is not manually collapsed', () => {
    expect(
      shouldAutoCollapsePanel({
        viewportWidth: 1024,
        threshold: 1200,
        persistedCollapsed: false,
      }),
    ).toBe(true);
  });

  it('does not auto-collapse above the threshold', () => {
    expect(
      shouldAutoCollapsePanel({
        viewportWidth: 1440,
        threshold: 1200,
        persistedCollapsed: false,
      }),
    ).toBe(false);
  });

  it('does not treat an already persisted manual collapse as responsive auto-collapse', () => {
    expect(
      shouldAutoCollapsePanel({
        viewportWidth: 1024,
        threshold: 1200,
        persistedCollapsed: true,
      }),
    ).toBe(false);
  });
});
