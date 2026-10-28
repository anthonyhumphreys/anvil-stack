import { describe, expect, it } from 'vitest';
import {
  CHAT_SCROLL_STORAGE_LIMIT,
  chatScrollPositionFromMetrics,
  chatScrollStorageKey,
  readChatScrollPosition,
  scrollTopForChatPosition,
  writeChatScrollPosition,
} from '../chat-scroll-position';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

describe('chat scroll position helpers', () => {
  it('stores bottom stickiness or the scroll position from the top', () => {
    expect(
      chatScrollPositionFromMetrics({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }),
    ).toEqual({ mode: 'bottom' });
    expect(
      chatScrollPositionFromMetrics({ scrollHeight: 1000, scrollTop: 600, clientHeight: 100 }),
    ).toEqual({ mode: 'offset', scrollTop: 600 });
  });

  it('preserves the reader position when content is appended and clamps it after content shrinks', () => {
    const metrics = { scrollHeight: 1000, scrollTop: 0, clientHeight: 100 };
    expect(scrollTopForChatPosition(metrics, { mode: 'offset', scrollTop: 300 })).toBe(300);
    expect(
      scrollTopForChatPosition(
        { scrollHeight: 250, scrollTop: 0, clientHeight: 100 },
        { mode: 'offset', scrollTop: 300 },
      ),
    ).toBe(150);
    expect(scrollTopForChatPosition(metrics, { mode: 'bottom' })).toBe(900);
    expect(
      scrollTopForChatPosition(
        { scrollHeight: 1500, scrollTop: 0, clientHeight: 100 },
        { mode: 'offset', scrollTop: 100 },
      ),
    ).toBe(100);
  });

  it('restores a stable turn anchor when content above that turn changes height', () => {
    expect(
      scrollTopForChatPosition(
        { scrollHeight: 1500, scrollTop: 0, clientHeight: 100 },
        {
          mode: 'offset',
          scrollTop: 400,
          anchor: { turnKey: 'turn-7', offsetFromTurnTop: 30 },
        },
        520,
      ),
    ).toBe(550);
  });

  it('keeps metadata in per-scope session records and evicts the oldest scopes', () => {
    const storage = new MemoryStorage();
    const firstScope = 'workspace-a:thread-0';
    const finalScope = `workspace-a:thread-${CHAT_SCROLL_STORAGE_LIMIT}`;

    for (let index = 0; index <= CHAT_SCROLL_STORAGE_LIMIT; index += 1) {
      writeChatScrollPosition(storage, `workspace-a:thread-${index}`, {
        mode: 'offset',
        scrollTop: index * 10,
        anchor: { turnKey: `turn-${index}`, offsetFromTurnTop: 12 },
      });
    }

    expect(readChatScrollPosition(storage, firstScope)).toBeNull();
    expect(readChatScrollPosition(storage, finalScope)).toEqual({
      mode: 'offset',
      scrollTop: CHAT_SCROLL_STORAGE_LIMIT * 10,
      anchor: { turnKey: `turn-${CHAT_SCROLL_STORAGE_LIMIT}`, offsetFromTurnTop: 12 },
    });
    expect(storage.getItem(chatScrollStorageKey(finalScope))).not.toContain('message');
    expect(JSON.parse(storage.getItem(chatScrollStorageKey(finalScope)) ?? '{}')).toEqual({
      version: 1,
      mode: 'offset',
      scrollTop: CHAT_SCROLL_STORAGE_LIMIT * 10,
      anchor: { turnKey: `turn-${CHAT_SCROLL_STORAGE_LIMIT}`, offsetFromTurnTop: 12 },
    });
  });

  it('ignores invalid or unsupported stored values', () => {
    const storage = new MemoryStorage();
    const key = chatScrollStorageKey('workspace:thread');
    storage.setItem(key, '{broken');
    expect(readChatScrollPosition(storage, 'workspace:thread')).toBeNull();

    storage.setItem(key, JSON.stringify({ version: 2, mode: 'bottom' }));
    expect(readChatScrollPosition(storage, 'workspace:thread')).toBeNull();
  });
});
