import { describe, expect, it, vi } from 'vitest';
import { createSkillRecommendationSaver } from '../skill-recommendations-save';

const source = { id: 'team', name: 'Team', description: '', repository: 'acme/skills' };

describe('organisation collection autosave', () => {
  it('preserves rapid edits while a prior field is still saving', async () => {
    let finishFirst!: () => void;
    const persist = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const saver = createSkillRecommendationSaver(3, [], persist);
    const first = saver.save([source]);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const next = { ...source, path: 'skills' };
    const second = saver.save([next]);
    expect(persist).toHaveBeenCalledTimes(1);
    finishFirst();
    await expect(first).resolves.toMatchObject({ version: 4 });
    await expect(second).resolves.toEqual({ version: 5, sources: [next] });
    expect(persist.mock.calls).toEqual([
      [[source], 3],
      [[next], 4],
    ]);
  });
  it('deduplicates normalized snapshots from repeated blur events', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const saver = createSkillRecommendationSaver(0, [], persist);
    await Promise.all([
      saver.save([source]),
      saver.save([{ ...source, repository: 'https://github.com/acme/skills' }]),
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it('keeps the last acknowledged version after a failed save so retries cannot overwrite newer state', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValue(undefined);
    const saver = createSkillRecommendationSaver(2, [], persist);
    await expect(saver.save([source])).rejects.toThrow('conflict');
    await expect(saver.save([source])).resolves.toMatchObject({ version: 3 });
    expect(persist.mock.calls.map((call) => call[1])).toEqual([2, 2]);
  });
});
