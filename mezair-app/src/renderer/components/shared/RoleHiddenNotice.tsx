import { EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Feature, UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { Button } from '../ui';
import { SettingsLink } from './SettingsLink';

/**
 * ST8: rendered in place of a feature that the current role hides, instead of
 * silently redirecting. "Show anyway" relies on `AppSettings.showAllTools`
 * (Settings → Profile & appearance) — wiring App.tsx's route guard to honor
 * it is part of the integration pass.
 */
export function RoleHiddenNotice({
  feature,
  userRole,
  onShowAnyway,
  children,
}: {
  /** The gated feature, used to check whether it is actually hidden. */
  feature: Feature;
  userRole?: UserRole;
  /** Rendered content once the user chooses to see the feature anyway. */
  onShowAnyway: () => void;
  children?: ReactNode;
}) {
  const hidden = !userRole || !ROLE_FEATURES[userRole].includes(feature);

  if (!hidden) return <>{children}</>;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-lg border border-border bg-bg-secondary p-6 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-border bg-bg-primary text-text-tertiary">
          <EyeOff size={18} />
        </div>
        <h2 className="text-base font-semibold text-text-primary">Hidden by your role</h2>
        <p className="text-sm text-text-secondary">
          This tool isn&apos;t part of the <span className="font-medium">{userRole}</span> toolset.
          You can open it anyway, or change which tools your role shows.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onShowAnyway}>
            Show anyway
          </Button>
          <SettingsLink to="profile#role" className="text-sm">
            Change role
          </SettingsLink>
        </div>
      </div>
    </div>
  );
}
