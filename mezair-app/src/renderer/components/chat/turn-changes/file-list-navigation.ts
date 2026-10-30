/**
 * Arrow-key movement for the per-turn file list (roving focus). Returns the
 * index to focus, or null when the key isn't a navigation key.
 */
export function nextFileListIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
