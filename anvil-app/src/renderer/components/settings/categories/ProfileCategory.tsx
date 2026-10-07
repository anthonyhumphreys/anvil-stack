import { Compass } from 'lucide-react';
import type { AppTheme, UserRole } from '../../../../shared/types';
import { useBrand } from '../../../contexts/BrandContext';
import { Button } from '../../ui';
import { useSettingsContext } from '../SettingsContext';
import { ButtonGrid, ProviderButton, SettingsPanel } from '../settings-ui';

const THEME_OPTIONS: Array<{
  id: AppTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
}> = [
  {
    id: 'system',
    label: 'System',
    description: 'Follows your device appearance, light or dark.',
    swatches: ['#fbfbfc', '#111318', '#4f46e5'],
  },
  {
    id: 'light',
    label: 'Anvil Light',
    description: 'Minimal, bright, stays out of the way.',
    swatches: ['#fbfbfc', '#ffffff', '#4f46e5'],
  },
  {
    id: 'dark',
    label: 'Anvil Dark',
    description: 'Minimal dark workspace for low-light sessions.',
    swatches: ['#0b1020', '#14213d', '#ff8a3d'],
  },
  {
    id: 'prompt-whisperer',
    label: 'Prompt Whisperer',
    description: 'Soft teal for calm context herding.',
    swatches: ['#071b1f', '#12343b', '#3ddbd9'],
  },
  {
    id: 'merge-conflict',
    label: 'Merge Conflict',
    description: 'Red and cyan, but on speaking terms.',
    swatches: ['#120d18', '#2d1736', '#ff5c8a'],
  },
  {
    id: 'token-bender',
    label: 'Token Bender',
    description: 'High-energy violet for long reasoning loops.',
    swatches: ['#100f2a', '#211a4f', '#9f7aea'],
  },
  {
    id: 'agent-after-hours',
    label: 'Agent After Hours',
    description: 'Late-night graphite with laser green signal.',
    swatches: ['#07110d', '#17241d', '#6ee7b7'],
  },
];

const ROLE_OPTIONS: Array<{ id: UserRole; label: string; description: string }> = [
  { id: 'developer', label: 'Developer', description: 'Build, review, and operate software' },
  { id: 'ba-brm', label: 'BA / BRM', description: 'Shape delivery work and decisions' },
  { id: 'design', label: 'Design', description: 'Explore and communicate product intent' },
  { id: 'itsm', label: 'ITSM', description: 'Coordinate service work and improvement' },
];

function ThemeButton({
  label,
  description,
  swatches,
  active,
  onClick,
}: {
  label: string;
  description: string;
  swatches: [string, string, string];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
          {label}
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-full border border-border-subtle">
          {swatches.map((swatch) => (
            <span
              key={swatch}
              className="h-5 w-5"
              style={{ backgroundColor: swatch }}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      <div className="mt-1 text-sm text-text-tertiary">{description}</div>
    </button>
  );
}

export function ProfileCategory() {
  const { draft, userRole, onRoleChange, onThemeChange, onPreviewOnboarding, reportError } =
    useSettingsContext();
  const brand = useBrand();

  const persistedTheme = draft.settings.theme ?? brand.defaultTheme;
  const selectedTheme = THEME_OPTIONS.some((theme) => theme.id === persistedTheme)
    ? persistedTheme
    : brand.defaultTheme;

  const selectRole = async (role: UserRole) => {
    try {
      await window.anvil.settings.update({ userRole: role });
      draft.applyPersisted({ userRole: role });
      onRoleChange?.(role);
    } catch (err) {
      console.error('[Settings] Failed to update role:', err);
      reportError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const updateTheme = async (theme: AppTheme) => {
    onThemeChange?.(theme);
    try {
      await window.anvil.settings.update({ theme });
      draft.applyPersisted({ theme });
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to update theme');
    }
  };

  return (
    <>
      <SettingsPanel
        panelId="role"
        title="Role"
        description="Controls which tools are visible in the sidebar."
        saveKeys={['userRole', 'showAllTools']}
        autosave
      >
        <ButtonGrid>
          {ROLE_OPTIONS.map((role) => (
            <ProviderButton
              key={role.id}
              label={role.label}
              description={role.description}
              active={userRole === role.id}
              onClick={() => void selectRole(role.id)}
            />
          ))}
        </ButtonGrid>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-primary p-4 transition-colors hover:bg-bg-tertiary">
          <input
            type="checkbox"
            checked={draft.settings.showAllTools ?? false}
            onChange={(event) => draft.update('showAllTools', event.target.checked)}
            className="mt-1 h-4 w-4 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">Show all tools</span>
            <span className="mt-1 block text-sm leading-relaxed text-text-secondary">
              Keep every tool visible in the sidebar regardless of role. Hidden tools still open
              from direct links and the command palette.
            </span>
          </span>
        </label>

        {onPreviewOnboarding && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">Preview first-run setup</p>
              <p className="mt-0.5 text-xs text-text-tertiary">
                Replay the role and connector screens without changing saved settings.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={onPreviewOnboarding}>
              <Compass size={14} aria-hidden="true" />
              Preview onboarding
            </Button>
          </div>
        )}
      </SettingsPanel>

      <SettingsPanel
        panelId="theme"
        title="Theme"
        description="Pick the colour mood for the app."
        saveKeys={['theme']}
        autosave
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEME_OPTIONS.map((theme) => (
            <ThemeButton
              key={theme.id}
              label={theme.label}
              description={theme.description}
              swatches={theme.swatches}
              active={selectedTheme === theme.id}
              onClick={() => void updateTheme(theme.id)}
            />
          ))}
        </div>
      </SettingsPanel>
    </>
  );
}
