import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { buildSettingsPath } from '../settings/settings-route';
import { cx } from '../ui';

/**
 * Deep link into Settings (ST4).
 *
 * `to` is `"category"` or `"category#panel"`, e.g.
 * `<SettingsLink to="delivery#git">Git credentials</SettingsLink>` renders a
 * link to `/settings/delivery#git`.
 *
 * Requires the `/settings/:category?` route in App.tsx (integration pass); a
 * bare `/settings` route would drop the category segment on the catch-all.
 *
 * First-run overlays (WelcomeOverlay → ConnectorSetupOverlay/SyncMeshSetupCard)
 * mount before `<HashRouter>`, so outside a router this renders a plain hash
 * anchor — the URL still lands on the right panel once the router mounts.
 */
export function SettingsLink({
  to,
  children,
  className,
}: {
  /** `"category"` or `"category#panel"` — see the settings registry. */
  to: string;
  children?: ReactNode;
  className?: string;
}) {
  const inRouter = useInRouterContext();
  const [category, panel] = to.split('#');
  const path = buildSettingsPath(category, panel);
  const classNames = cx(
    'inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline',
    className,
  );

  if (!inRouter) {
    return (
      <a href={`#${path}`} className={classNames}>
        {children ?? 'Open Settings'}
      </a>
    );
  }

  return (
    <Link to={path} className={classNames}>
      {children ?? 'Open Settings'}
    </Link>
  );
}
