export function getNextListboxIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;

  switch (key) {
    case 'ArrowDown':
      return (currentIndex + 1) % itemCount;
    case 'ArrowUp':
      return (currentIndex - 1 + itemCount) % itemCount;
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    default:
      return null;
  }
}
