/** Async navigation may finish after a newer user choice; only its initiating choice may act. */
export function createChatNavigationRequests() {
  let version = 0;
  return {
    invalidate() {
      version += 1;
    },
    begin() {
      const request = ++version;
      return () => version === request;
    },
  };
}
