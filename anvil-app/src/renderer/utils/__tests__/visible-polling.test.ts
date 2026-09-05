import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollWhileVisible } from '../visible-polling';

let documentStub: EventTarget & { hidden: boolean };
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  documentStub = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', documentStub);
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('visible polling', () => {
  it('pauses when hidden and refreshes immediately on return', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    stop = pollWhileVisible(refresh, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    documentStub.hidden = true;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    documentStub.hidden = false;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('does not overlap requests or restart after disposal during an in-flight request', async () => {
    let complete!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    stop = pollWhileVisible(refresh, 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    documentStub.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledOnce();
    stop();
    complete();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
