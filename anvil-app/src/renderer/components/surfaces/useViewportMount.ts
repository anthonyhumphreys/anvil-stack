import { useEffect, useState, type RefObject } from 'react';

/**
 * Becomes true once the element is near the viewport and stays true, so heavy
 * surfaces and frames mount lazily without unmounting on scroll.
 */
export function useViewportMount(
  ref: RefObject<HTMLElement | null>,
  { rootMargin = '800px 0px', disabled = false }: { rootMargin?: string; disabled?: boolean } = {},
): boolean {
  const [mounted, setMounted] = useState(
    disabled || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (mounted) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted, ref, rootMargin]);

  return mounted;
}
