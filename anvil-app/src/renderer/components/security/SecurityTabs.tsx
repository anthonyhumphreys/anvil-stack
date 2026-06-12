import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Shield, Crosshair, Boxes } from 'lucide-react';

const tabs = [
  { key: 'audit', label: 'Static Audit', icon: Shield, pathSuffix: '' },
  { key: 'pentest', label: 'Penetration Testing', icon: Crosshair, pathSuffix: '/pentest' },
  { key: 'deps', label: 'Dependencies Audit', icon: Boxes, pathSuffix: '/dependencies' },
] as const;

export function SecurityTabs() {
  const { repoId } = useParams<{ repoId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const isPentest = location.pathname.includes('/pentest');
  const isDeps = location.pathname.includes('/dependencies');
  const activeKey = isDeps ? 'deps' : isPentest ? 'pentest' : 'audit';

  return (
    <div className="flex border-b border-border-subtle bg-bg-secondary px-4">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            onClick={() => navigate(`/security/${repoId || ''}${tab.pathSuffix}`)}
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
