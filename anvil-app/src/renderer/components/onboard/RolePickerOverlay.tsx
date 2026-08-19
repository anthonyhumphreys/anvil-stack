import { useBrand } from '../../contexts/BrandContext';
import type { UserRole } from '../../../shared/types';
import { ArrowRight, Code2, LifeBuoy, PenTool, Workflow, type LucideIcon } from 'lucide-react';

interface RoleOption {
  role: UserRole;
  label: string;
  description: string;
  strengths: string;
  icon: LucideIcon;
}

const ROLES: RoleOption[] = [
  {
    role: 'developer',
    label: 'Developer',
    description: 'Build, review, and operate software',
    strengths: 'Code · delivery · security',
    icon: Code2,
  },
  {
    role: 'ba-brm',
    label: 'BA / BRM',
    description: 'Shape delivery work and decisions',
    strengths: 'Work items · docs · diagrams',
    icon: Workflow,
  },
  {
    role: 'design',
    label: 'Design',
    description: 'Explore and communicate product intent',
    strengths: 'Chat · diagrams · governance',
    icon: PenTool,
  },
  {
    role: 'itsm',
    label: 'ITSM',
    description: 'Coordinate service work and improvement',
    strengths: 'Incidents · risk · compliance',
    icon: LifeBuoy,
  },
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
    <div className="flex h-screen items-start justify-center overflow-y-auto bg-bg-primary py-14 sm:items-center">
      <div className="titlebar-drag fixed inset-x-0 top-0 h-10" />
      <div className="w-full max-w-md space-y-6 px-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-accent">{brand.appName}</h1>
          <p className="mt-1 text-sm text-text-secondary">What best describes your role?</p>
        </div>

        <div className="space-y-3">
          {ROLES.map(({ role, label, description, strengths, icon: Icon }) => {
            return (
              <button
                key={role}
                onClick={() => handleSelect(role)}
                className="group flex w-full items-center gap-4 rounded-lg border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent hover:bg-accent/5"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg-tertiary text-text-secondary group-hover:text-accent">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <div className="flex-1">
                  <div className="text-base font-semibold text-text-primary">{label}</div>
                  <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
                  <div className="mt-1 text-xs text-text-muted">{strengths}</div>
                </div>
                <ArrowRight
                  size={16}
                  className="text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
