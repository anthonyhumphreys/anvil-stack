import { useSearchParams } from 'react-router-dom';
import { NotebookPen } from 'lucide-react';
import type { Feature } from '../../../shared/types';
import type { NotesTab } from '../../utils/sidebar-navigation';
import { WorkspaceNotesView } from '../workspace/WorkspaceNotesView';
import { MeetingNotesView } from '../meeting/MeetingNotesView';
import { ViewTabs, type ViewTab } from '../library/ViewTabs';
import { isFeatureAllowed, useAllowedFeatures } from '../library/useAllowedFeatures';
import { EmptyState } from '../layout/ViewScaffold';
import { resolveNotesTab } from './notes-tabs';

const NOTES_TABS: Array<ViewTab<NotesTab> & { feature: Feature }> = [
  { id: 'workspace', label: 'Workspace notes', feature: 'workspace-notes' },
  { id: 'meeting', label: 'Meeting notes', feature: 'meeting-notes' },
];

/**
 * Spec §12: Meeting Notes and Workspace Notes merge into one Notes
 * destination (`/notes?tab=workspace|meeting`). `/meeting-notes` and
 * `/workspace-notes` redirect here. Each tab keeps its own role gate.
 */
export function NotesView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const allowed = useAllowedFeatures();
  const tabs = NOTES_TABS.filter((tab) => isFeatureAllowed(allowed, tab.feature));
  const tab = resolveNotesTab(
    searchParams.get('tab'),
    tabs.map((entry) => entry.id),
  );

  const selectTab = (next: NotesTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  if (!tab) {
    return (
      <EmptyState
        icon={NotebookPen}
        title="Notes aren't available for your role"
        description="Switch role or turn on “Show all tools” in Settings to use workspace and meeting notes."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-4 border-b border-border bg-bg-secondary/45 px-5">
        <span className="flex items-center gap-2 py-2.5 text-sm font-semibold text-text-primary">
          <NotebookPen size={16} className="text-accent" aria-hidden="true" />
          Notes
        </span>
        <ViewTabs
          tabs={tabs}
          value={tab}
          onChange={selectTab}
          label="Notes"
          idPrefix="notes-tab"
          size="sm"
        />
      </div>
      <div
        role="tabpanel"
        aria-labelledby={`notes-tab-${tab}`}
        className="min-h-0 flex-1"
        key={tab}
      >
        {tab === 'workspace' ? <WorkspaceNotesView /> : <MeetingNotesView />}
      </div>
    </div>
  );
}
