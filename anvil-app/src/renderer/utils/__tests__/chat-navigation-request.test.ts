import { describe, expect, it } from 'vitest';
import { createChatNavigationRequests } from '../chat-navigation-request';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('async chat navigation ownership', () => {
  it('does not activate a slow linked-thread lookup after selecting another thread', async () => {
    const requests = createChatNavigationRequests();
    const lookup = deferred<string>();
    const isA = requests.begin();
    let active = '';
    const openA = (async () => {
      const thread = await lookup.promise;
      if (isA()) active = thread;
    })();
    const isB = requests.begin();
    if (isB()) active = 'B';
    lookup.resolve('A');
    await openA;
    expect(active).toBe('B');
  });
  it('preserves a provider-created draft but does not activate or send after workspace navigation', async () => {
    const requests = createChatNavigationRequests();
    const lookup = deferred<string>();
    const current = requests.begin();
    const drafts: string[] = [];
    const activated: string[] = [];
    const sent: string[] = [];
    const launch = (async () => {
      const thread = await lookup.promise;
      drafts.push(thread);
      if (!current()) return;
      activated.push(thread);
      sent.push(thread);
    })();
    requests.invalidate();
    lookup.resolve('linked-draft');
    await launch;
    expect(drafts).toEqual(['linked-draft']);
    expect(activated).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('invalidates a launch while its session/save operation is awaiting', async () => {
    const requests = createChatNavigationRequests();
    const saved = deferred<void>();
    const current = requests.begin();
    let sends = 0;
    const dispatch = (async () => {
      await saved.promise;
      if (current()) sends += 1;
    })();
    requests.begin();
    saved.resolve();
    await dispatch;
    expect(sends).toBe(0);
  });
  it('keeps the initiating request valid until another navigation occurs', () => {
    const requests = createChatNavigationRequests();
    const current = requests.begin();
    expect(current()).toBe(true);
    requests.invalidate();
    expect(current()).toBe(false);
  });
});
