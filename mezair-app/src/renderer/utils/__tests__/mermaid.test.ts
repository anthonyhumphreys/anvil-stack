import { describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
import { renderMermaid } from '../mermaid';

describe('Mermaid preview scheduling', () => {
  it('keeps configuration paired with each render and recovers after invalid diagrams', async () => {
    let complete!: (result: { svg: string }) => void;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    mermaid.render.mockRejectedValueOnce(new Error('Invalid diagram'));
    mermaid.render.mockResolvedValueOnce({ svg: '<svg />' });
    const first = renderMermaid('canvas', 'graph TD; A-->B', { securityLevel: 'strict' });
    const second = renderMermaid('adr', 'invalid', { securityLevel: 'loose' });
    const rejection = expect(second).rejects.toThrow('Invalid diagram');
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    complete({ svg: '<svg />' });
    await first;
    await rejection;
    await expect(
      renderMermaid('next', 'graph TD; A-->B', { securityLevel: 'strict' }),
    ).resolves.toEqual({ svg: '<svg />' });
    expect(mermaid.initialize.mock.calls.map(([config]) => config.securityLevel)).toEqual([
      'strict',
      'loose',
      'strict',
    ]);
  });
});
