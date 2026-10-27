import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Shield, Boxes } from 'lucide-react';
import {
  repoDetailPath,
  repositoriesSectionHintPath,
  type RepoHealthTab,
} from '../../utils/sidebar-navigation';

const tabs: ReadonlyArray<{
  key: 'audit' | 'deps';
  label: string;
  icon: typeof Shield;
  healthTab: RepoHealthTab;
}> = [
  { key: 'audit', label: 'Static Audit', icon: Shield, healthTab: 'security' },
  { key: 'deps', label: 'Dependencies Audit', icon: Boxes, healthTab: 'dependencies' },
];

/**
 * Static / Dependencies audit switcher. Hidden when `embedded` in repo
 * Health, whose own tab bar already offers both.
 */
export function SecurityTabs({ embedded = false }: { embedded?: boolean }) {
  const { repoId } = useParams<{ repoId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  if (embedded) return null;

  const isDeps = location.pathname.includes('/dependencies');
  const activeKey = isDeps ? 'deps' : 'audit';

  return (
    <div className="flex border-b border-border-subtle bg-bg-secondary px-4">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            onClick={() =>
              navigate(
                repoId
                  ? repoDetailPath(repoId, 'health', tab.healthTab)
                  : repositoriesSectionHintPath('health', tab.healthTab),
              )
            }
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
              isActive
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            <Icon size={14} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
