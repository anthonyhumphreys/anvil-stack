import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../clipboard';

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await copyTextToClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to a temporary textarea when Clipboard API fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('blocked'));
    const textarea = { value: '', select: vi.fn() };
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', {
      body: { appendChild, removeChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await copyTextToClipboard('fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.value).toBe('fallback');
    expect(textarea.select).toHaveBeenCalled();
    expect(appendChild).toHaveBeenCalledWith(textarea);
    expect(removeChild).toHaveBeenCalledWith(textarea);
  });
});
