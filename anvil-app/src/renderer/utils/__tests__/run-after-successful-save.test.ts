import { describe, expect, it, vi } from 'vitest';
import { runAfterSuccessfulSave } from '../run-after-successful-save';

describe('runAfterSuccessfulSave', () => {
  it('does not run the action when settings could not be saved', async () => {
    const save = vi.fn().mockResolvedValue(false);
    const action = vi.fn().mockResolvedValue('connected');

    await expect(runAfterSuccessfulSave(save, action)).resolves.toEqual({ saved: false });
    expect(save).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });

  it('runs the action after a successful save and returns its result', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const action = vi.fn().mockResolvedValue('connected');

    await expect(runAfterSuccessfulSave(save, action)).resolves.toEqual({
      saved: true,
      value: 'connected',
    });
    expect(action).toHaveBeenCalledOnce();
  });
});
