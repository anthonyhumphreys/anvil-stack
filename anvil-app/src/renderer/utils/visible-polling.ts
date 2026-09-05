/** Poll presentation data only while visible, with at most one request in flight. */
export function pollWhileVisible(refresh: () => Promise<void>, intervalMs: number): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    if (stopped || running || document.hidden) return;
    running = true;
    try {
      await refresh();
    } catch (error) {
      console.error('[Polling] Refresh failed:', error);
    } finally {
      running = false;
      if (!stopped && !document.hidden) timer = setTimeout(() => void poll(), intervalMs);
    }
  };

  const onVisibilityChange = () => {
    clearTimeout(timer);
    if (!document.hidden) void poll();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  void poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
