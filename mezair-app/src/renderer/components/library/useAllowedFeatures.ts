import { useEffect, useState } from 'react';
import type { Feature } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';

/**
 * Role-allowed features for views that embed several tools (Library, repo
 * Health, Notes). Mirrors App's route guard: "Show all tools" (ST8) or a
 * missing role allows everything. Returns `null` while settings load, which
 * callers treat as allowed so nothing flickers away.
 */
export function useAllowedFeatures(): ReadonlySet<Feature> | null {
  const [allowed, setAllowed] = useState<ReadonlySet<Feature> | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.mezair.settings
      .get()
      .then((settings) => {
        if (cancelled) return;
        setAllowed(
          settings.showAllTools || !settings.userRole
            ? new Set(Object.values(ROLE_FEATURES).flat())
            : new Set(ROLE_FEATURES[settings.userRole]),
        );
      })
      .catch(() => {
        if (!cancelled) setAllowed(new Set(Object.values(ROLE_FEATURES).flat()));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return allowed;
}

export function isFeatureAllowed(
  allowed: ReadonlySet<Feature> | null,
  feature: Feature | undefined,
): boolean {
  return !feature || !allowed || allowed.has(feature);
}
