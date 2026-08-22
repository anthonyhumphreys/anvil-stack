import { useMemo } from 'react';
import { ArrowRight, CheckCircle2, Inbox } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  SidebarActivityIcon,
  useSidebarActivity,
  type SidebarActivityItem,
} from '../layout/SidebarActivityCenter';
import { EmptyState, ViewHeader } from '../layout/ViewScaffold';

export function InboxView() {
  const navigate = useNavigate();
  const { items } = useSidebarActivity();
  const sections = useMemo(
    () => [
      {
        id: 'attention',
        label: 'Needs you',
        description: 'Approvals, questions, failures, and completed work ready to review.',
        items: items.filter(
          (item) => item.status === 'error' || item.status === 'warning' || item.status === 'ready',
        ),
      },
      {
        id: 'progress',
        label: 'In progress',
        description: 'Agent work, automations, indexing, and local processes still running.',
        items: items.filter((item) => item.status === 'running' || item.status === 'queued'),
      },
    ],
    [items],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={Inbox}
        title="Inbox"
        description="Decisions waiting on you and work still running in this workspace."
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {items.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="You are caught up"
            description="Approvals, questions, failures, completed work, and active runs will appear here."
          />
        ) : (
          <div className="mx-auto max-w-4xl space-y-8">
            {sections.map((section) => (
              <section key={section.id}>
                <div className="mb-3 flex items-end justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">{section.label}</h3>
                    <p className="mt-0.5 text-xs text-text-tertiary">{section.description}</p>
                  </div>
                  <span className="text-xs tabular-nums text-text-tertiary">
                    {section.items.length}
                  </span>
                </div>
                {section.items.length === 0 ? (
                  <div className="border-t border-border-subtle py-4 text-sm text-text-tertiary">
                    {section.id === 'attention'
                      ? 'No decisions or completed work need review.'
                      : 'No work is currently running.'}
                  </div>
                ) : (
                  <div className="divide-y divide-border-subtle border-y border-border-subtle">
                    {section.items.map((item) => (
                      <InboxRow key={item.id} item={item} onOpen={() => navigate(item.route)} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InboxRow({ item, onOpen }: { item: SidebarActivityItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-3 px-2 py-3.5 text-left transition-colors hover:bg-bg-secondary"
    >
      <SidebarActivityIcon status={item.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{item.title}</span>
        <span className="mt-0.5 block truncate text-xs text-text-tertiary">{item.detail}</span>
      </span>
      {item.startedAt && (
        <span className="shrink-0 pt-0.5 text-xs text-text-tertiary">
          {formatActivityTime(item.startedAt)}
        </span>
      )}
      <ArrowRight
        size={14}
        className="mt-0.5 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-text-secondary"
      />
    </button>
  );
}

function formatActivityTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (elapsedMinutes < 1) return 'Now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}
