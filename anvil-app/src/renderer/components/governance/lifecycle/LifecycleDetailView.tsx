import { useState, useCallback, useEffect } from 'react';
import {
  Loader2,
  Activity,
  FileText,
  ShieldCheck,
  GitCompareArrows,
  PackageCheck,
} from 'lucide-react';
import type { LifecycleItem, LifecycleStage } from '../../../../shared/types';
import { LifecycleTimeline } from './LifecycleTimeline';
import { LifecycleOverview } from './LifecycleOverview';
import { GateReadinessPanel } from './GateReadinessPanel';
import { ImpactAnalysisPanel } from './ImpactAnalysisPanel';
import { HandoverPackPanel } from './HandoverPackPanel';

interface Props {
  itemId: string;
}

const STAGE_LABELS: Record<LifecycleStage, string> = {
  ideation: 'Ideation',
  discovery_design: 'Discovery & Design',
  build: 'Build',
  run: 'Run',
};

const STAGE_COLORS: Record<LifecycleStage, string> = {
  ideation: 'bg-blue-500',
  discovery_design: 'bg-purple-500',
  build: 'bg-amber-500',
  run: 'bg-emerald-500',
};

type DetailTab = 'timeline' | 'overview' | 'gates' | 'impact' | 'handover';

const TAB_CONFIG: Array<{
  key: DetailTab;
  label: string;
  icon: typeof FileText;
  requiresStage?: LifecycleStage[];
}> = [
  { key: 'timeline', label: 'Timeline', icon: Activity },
  { key: 'overview', label: 'Overview', icon: FileText },
  { key: 'gates', label: 'Gate Readiness', icon: ShieldCheck },
  { key: 'impact', label: 'Impact Analysis', icon: GitCompareArrows },
  { key: 'handover', label: 'Handover Pack', icon: PackageCheck, requiresStage: ['build', 'run'] },
];

export function LifecycleDetailView({ itemId }: Props) {
  const [item, setItem] = useState<LifecycleItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>('timeline');

  const loadItem = useCallback(async () => {
    if (!itemId) return;
    setLoading(true);
    try {
      const result = await window.anvil.lifecycle.getItem(itemId);
      setItem(result);
    } catch (err) {
      console.error('Failed to load lifecycle item:', err);
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    loadItem();
    setActiveTab('timeline');
  }, [loadItem]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Item not found.</p>
      </div>
    );
  }

  const visibleTabs = TAB_CONFIG.filter(
    (t) => !t.requiresStage || t.requiresStage.includes(item.stage),
  );

  // If current tab is hidden (e.g. handover on ideation stage), fall back
  if (!visibleTabs.find((t) => t.key === activeTab)) {
    setActiveTab('overview');
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="shrink-0 border-b border-border bg-bg-secondary px-5 py-3">
        <div className="flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${STAGE_COLORS[item.stage]}`} />
          <h2 className="text-base font-semibold text-text-primary">{item.title}</h2>
          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
            {STAGE_LABELS[item.stage]}
          </span>
          {item.changeClassification && (
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-secondary">
              {item.changeClassification}
            </span>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div className="shrink-0 flex gap-0 border-b border-border bg-bg-primary">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? 'border-b-2 border-accent text-accent'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <Icon size={13} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content — scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          {activeTab === 'timeline' && <LifecycleTimeline item={item} />}
          {activeTab === 'overview' && <LifecycleOverview item={item} onUpdate={loadItem} />}
          {activeTab === 'gates' && (
            <GateReadinessPanel
              lifecycleItemId={item.id}
              workspaceId={item.workspaceId}
              currentStage={item.stage}
            />
          )}
          {activeTab === 'impact' && (
            <ImpactAnalysisPanel lifecycleItemId={item.id} linkedRepoIds={item.linkedRepoIds} />
          )}
          {activeTab === 'handover' && (
            <HandoverPackPanel lifecycleItemId={item.id} linkedRepoIds={item.linkedRepoIds} />
          )}
        </div>
      </div>
    </div>
  );
}
