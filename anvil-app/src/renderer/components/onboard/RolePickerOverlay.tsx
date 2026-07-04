import { useBrand } from '../../contexts/BrandContext';
import type { UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';

const ROLE_LABELS: Record<string, string> = {
  repos: 'Repositories',
  chat: 'Chat',
  onboard: 'Onboarding',
  workitems: 'Work Items',
  security: 'Security',
  codereview: 'Code Review',
  docs: 'Documentation',
  diagrams: 'Diagrams',
  governance: 'Governance',
  compliance: 'Compliance',
  adrs: 'ADRs',
  browser: 'Browser',
  git: 'Git',
};

interface RoleOption {
  role: UserRole;
  label: string;
  description: string;
}

const ROLES: RoleOption[] = [
  { role: 'developer', label: 'Developer', description: 'Full access to all tools' },
  { role: 'ba-brm', label: 'BA / BRM', description: 'Docs, diagrams, chat & work items' },
  { role: 'design', label: 'Design', description: 'Design companion with Figma & diagrams' },
];

interface RolePickerOverlayProps {
  onRoleSelected: (role: UserRole) => void;
}

export function RolePickerOverlay({ onRoleSelected }: RolePickerOverlayProps) {
  const brand = useBrand();

  const handleSelect = async (role: UserRole) => {
    try {
      await window.anvil.settings.update({ userRole: role });
      onRoleSelected(role);
    } catch (err) {
      console.error('[RolePickerOverlay] Failed to save role:', err);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-bg-primary">
      <div className="titlebar-drag fixed inset-x-0 top-0 h-10" />
      <div className="w-full max-w-md space-y-6 px-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent">{brand.appName}</h1>
          <p className="mt-1 text-sm text-text-secondary">What best describes your role?</p>
        </div>

        <div className="space-y-3">
          {ROLES.map(({ role, label, description }) => {
            const features = ROLE_FEATURES[role]
              .filter((feature) => feature !== 'cloud')
              .map((feature) => ROLE_LABELS[feature] ?? feature)
              .join(' · ');
            return (
              <button
                key={role}
                onClick={() => handleSelect(role)}
                className="flex w-full items-center gap-4 rounded-lg border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent hover:bg-accent/5"
              >
                <div className="flex-1">
                  <div className="text-base font-semibold text-text-primary">{label}</div>
                  <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
                  <div className="mt-2 text-xs text-text-tertiary">{features}</div>
                </div>
                <span className="text-text-tertiary">&rarr;</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
