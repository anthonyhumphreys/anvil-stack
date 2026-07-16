import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TicketCheck,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ClipboardCopy,
  FileText,
  Wrench,
  MessageSquare,
  GitCompareArrows,
  Search,
  X,
} from 'lucide-react';
import type { Iteration, RepoInfo, WorkItem, WorkItemConnection } from '../../../shared/types';
import { SprintSelector } from './SprintSelector';
import { TagFilter } from './TagFilter';
import { WorkItemCard } from './WorkItemCard';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useChatContext } from '../../contexts/ChatContext';
import { copyTextToClipboard } from '../../utils/clipboard';

type ActionType = 'plan' | 'fix' | 'ba' | 'impact' | null;

/**
 * Build a tree from a flat list using parentId.
 * Items whose parent is not in the list become root-level.
 */
function buildWorkItemTree(items: WorkItem[]): WorkItem[] {
  const map = new Map<string, WorkItem>();
  for (const item of items) {
    map.set(item.id, { ...item, children: [] });
  }

  const roots: WorkItem[] = [];
  for (const item of map.values()) {
    if (item.parentId && map.has(item.parentId)) {
      map.get(item.parentId)!.children!.push(item);
    } else {
      roots.push(item);
    }
  }

  return roots;
}

export function WorkItemsView() {
  const navigate = useNavigate();
  const { activeWorkspace, featureAvailability, updatePreferences } = useWorkspace();
  const { activeRepos, launchPreparedChat } = useChatContext();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Sprint / iteration state (persisted per workspace)
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [selectedIterations, setSelectedIterations] = useState<string[]>([]);

  // Tag filter state
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Active work item provider
  const [activeProvider, setActiveProvider] = useState<string>('ado');
  const [activeConnectionId, setActiveConnectionId] = useState('');
  const [connections, setConnections] = useState<WorkItemConnection[]>([]);
  const [switchingProvider, setSwitchingProvider] = useState(false);

  // Generated content panel
  const [activeItem, setActiveItem] = useState<WorkItem | null>(null);
  const [activeAction, setActiveAction] = useState<ActionType>(null);
  const [generatedContent, setGeneratedContent] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.anvil.settings.get().then((settings) => {
      setActiveProvider(settings.workItemProvider ?? 'none');
      setActiveConnectionId(settings.activeWorkItemConnectionId ?? '');
      setConnections(settings.workItemConnections ?? []);
    });
  }, []);

  const handleConnectionChange = useCallback(
    async (connectionId: string) => {
      const connection = connections.find((candidate) => candidate.id === connectionId);
      if (!connection) return;
      setSwitchingProvider(true);
      setActiveConnectionId(connectionId);
      setActiveProvider(connection.provider);
      setItems([]);
      setIterations([]);
      setSelectedIterations([]);
      setSelectedTags([]);
      try {
        await window.anvil.settings.update({
          activeWorkItemConnectionId: connectionId,
        });
        const [newItems, newIterations] = await Promise.all([
          window.anvil.workitems.list(),
          window.anvil.workitems.listIterations().catch(() => [] as Iteration[]),
        ]);
        setItems(newItems);
        setIterations(newIterations);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to switch provider');
      } finally {
        setSwitchingProvider(false);
      }
    },
    [connections],
  );

  // Sync iteration selection FROM workspace preferences on workspace switch
  useEffect(() => {
    const workspaceIterations = activeWorkspace?.preferences?.workitems.iterationIds ?? [];
    setSelectedIterations((prev) =>
      sameStringArray(prev, workspaceIterations) ? prev : workspaceIterations,
    );
  }, [activeWorkspace?.id]);

  // Persist iteration selection TO workspace preferences on change
  const selectedIterationsRef = useRef(selectedIterations);
  selectedIterationsRef.current = selectedIterations;

  useEffect(() => {
    if (!activeWorkspace) return;

    const currentIds = activeWorkspace.preferences?.workitems.iterationIds ?? [];
    if (sameStringArray(currentIds, selectedIterations)) return;

    const nextNames = selectedIterations
      .map((id) => iterations.find((iteration) => iteration.id === id)?.name)
      .filter((value): value is string => Boolean(value));

    void updatePreferences({
      workitems: {
        iterationIds: selectedIterations,
        iterationNames: nextNames,
      },
    });
  }, [selectedIterations, iterations]);

  // Fetch iterations on mount
  useEffect(() => {
    window.anvil.workitems
      .listIterations()
      .then(setIterations)
      .catch(() => {
        // Non-fatal — just means no sprint selector
      });
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters =
        selectedIterations.length > 0 ? { iterationIds: selectedIterations } : undefined;
      const result = await window.anvil.workitems.list(filters);
      setItems(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work items');
    } finally {
      setLoading(false);
    }
  }, [selectedIterations]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const handleAction = useCallback(
    async (item: WorkItem, action: ActionType) => {
      if (action === 'ba') {
        navigate(`/ba/${item.id}`);
        return;
      }

      if (action === 'impact') {
        if (!featureAvailability.repoFeaturesEnabled) {
          setError(
            featureAvailability.repoFeatureReason ??
              'Index repositories to unlock impact assessment.',
          );
          return;
        }

        setError(null);
        const scopeItems = getImpactScopeItems(item, items);
        const targetRepos = await resolveImpactAssessmentRepos(
          scopeItems,
          activeRepos,
          activeWorkspace?.repos ?? [],
        );
        const prompt = buildImpactAssessmentPrompt(
          item,
          scopeItems,
          targetRepos.map((repo) => repo.name),
        );

        navigate('/chat');
        await launchPreparedChat({
          personaId: 'ba',
          repoIds: targetRepos.map((repo) => repo.id),
          message: prompt,
          threadTitle: `Impact assessment: ${item.title}`,
          workItem: item,
        });
        return;
      }

      setActiveItem(item);
      setActiveAction(action);
      setGeneratedContent('');
      setGenerating(true);
      setCopied(false);

      try {
        const result =
          action === 'plan'
            ? await window.anvil.workitems.plan(item.id)
            : await window.anvil.workitems.generateFixPrompt(item.id);
        setGeneratedContent(result);
      } catch (err) {
        setGeneratedContent(`Error: ${err instanceof Error ? err.message : 'Generation failed'}`);
      } finally {
        setGenerating(false);
      }
    },
    [
      activeRepos,
      activeWorkspace?.repos,
      featureAvailability.repoFeatureReason,
      featureAvailability.repoFeaturesEnabled,
      items,
      launchPreparedChat,
      navigate,
    ],
  );

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(generatedContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generatedContent]);

  // Collect all unique tags from items
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const item of items) {
      if (item.tags) {
        for (const tag of item.tags) tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [items]);

  // Filter pipeline: text search → tag filter → build tree
  const treeItems = useMemo(() => {
    let filtered = items;

    // Text search
    if (filter) {
      const lc = filter.toLowerCase();
      filtered = filtered.filter(
        (item) =>
          item.title.toLowerCase().includes(lc) ||
          item.id.includes(filter) ||
          item.type.toLowerCase().includes(lc),
      );
    }

    // Tag filter (AND logic)
    if (selectedTags.length > 0) {
      filtered = filtered.filter((item) => selectedTags.every((tag) => item.tags?.includes(tag)));
    }

    return buildWorkItemTree(filtered);
  }, [items, filter, selectedTags]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-bg-secondary px-4 py-2">
        <div className="flex items-center gap-3">
          <TicketCheck size={20} className="text-accent" />
          <h2 className="text-xl font-semibold">Work Items</h2>
          <span className="rounded bg-bg-tertiary px-2 py-0.5 text-xs text-text-tertiary">
            {items.length} items
          </span>
          <select
            value={activeConnectionId}
            onChange={(e) => handleConnectionChange(e.target.value)}
            disabled={switchingProvider}
            className="rounded-md border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary focus:border-accent focus:outline-none disabled:opacity-50"
          >
            {connections.length === 0 && <option value="">No connections</option>}
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} · {connection.provider.toUpperCase()}
              </option>
            ))}
          </select>
          <SprintSelector
            iterations={iterations}
            selected={selectedIterations}
            onChange={setSelectedIterations}
            label={activeProvider === 'linear' ? 'Cycle' : 'Sprint'}
          />
        </div>
        <button
          onClick={loadItems}
          disabled={loading}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {/* Search bar + tag filter */}
      <div className="space-y-2 border-b border-border bg-bg-secondary px-4 py-2">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title, ID, or type..."
            className="w-full rounded-md border border-border bg-bg-primary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
        <TagFilter allTags={allTags} selected={selectedTags} onChange={setSelectedTags} />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Work items list */}
        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-4 flex items-start gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          {loading && items.length === 0 ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 size={24} className="animate-spin text-accent" />
            </div>
          ) : treeItems.length === 0 ? (
            <div className="flex h-64 items-center justify-center">
              <div className="text-center">
                <TicketCheck size={32} className="mx-auto mb-3 text-text-tertiary" />
                <p className="text-sm text-text-secondary">
                  {items.length === 0
                    ? connections.length === 0
                      ? 'Configure a work item connection in Settings.'
                      : 'No work items found. Check settings.'
                    : 'No items match your filter.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {treeItems.map((item) => (
                <WorkItemCard
                  key={item.id}
                  item={item}
                  depth={0}
                  activeId={activeItem?.id}
                  impactAssessmentEnabled={featureAvailability.repoFeaturesEnabled}
                  onAction={handleAction}
                />
              ))}
            </div>
          )}
        </div>

        {/* Generated content panel */}
        {activeItem && activeAction && (
          <div className="w-[420px] shrink-0 border-l border-border bg-bg-secondary">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-2">
                {activeAction === 'plan' ? (
                  <FileText size={14} className="text-info" />
                ) : activeAction === 'fix' ? (
                  <Wrench size={14} className="text-success" />
                ) : (
                  <GitCompareArrows size={14} className="text-warning" />
                )}
                <span className="text-sm font-medium text-text-primary">
                  {activeAction === 'plan'
                    ? 'Implementation Plan'
                    : activeAction === 'fix'
                      ? 'Fix Prompt'
                      : 'Impact Assessment'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {generatedContent && !generating && (
                  <button
                    onClick={handleCopy}
                    aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
                    className="flex items-center gap-1 rounded px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
                  >
                    <ClipboardCopy size={10} />
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                )}
                <button
                  onClick={() => {
                    setActiveItem(null);
                    setActiveAction(null);
                  }}
                  aria-label="Close panel"
                  className="rounded p-1 text-text-tertiary hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-xs text-text-secondary">
                #{activeItem.id} — {activeItem.title}
              </p>
              <button
                onClick={() => navigate(`/ba/${activeItem.id}`)}
                className="flex items-center gap-1 rounded px-2 py-1 text-sm text-accent hover:bg-accent/10"
                title="BA Chat"
              >
                <MessageSquare size={10} />
                BA Chat
              </button>
            </div>

            <div className="flex-1 overflow-auto px-3 pb-3">
              {generating ? (
                <div className="flex h-48 items-center justify-center">
                  <div className="text-center">
                    <Loader2 size={20} className="mx-auto mb-2 animate-spin text-accent" />
                    <p className="text-sm text-text-secondary">Generating with AI...</p>
                  </div>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-bg-primary p-3 text-sm text-text-primary">
                  {generatedContent}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getImpactScopeItems(rootItem: WorkItem, allItems: WorkItem[]): WorkItem[] {
  if (rootItem.type !== 'Epic') {
    return [rootItem];
  }

  const childrenByParent = new Map<string, WorkItem[]>();
  for (const item of allItems) {
    if (!item.parentId) continue;
    const existing = childrenByParent.get(item.parentId) ?? [];
    existing.push(item);
    childrenByParent.set(item.parentId, existing);
  }

  const scope: WorkItem[] = [];
  const stack: WorkItem[] = [rootItem];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    scope.push(current);

    const children = childrenByParent.get(current.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return scope;
}

async function resolveImpactAssessmentRepos(
  scopeItems: WorkItem[],
  activeRepos: RepoInfo[],
  workspaceRepos: RepoInfo[],
): Promise<RepoInfo[]> {
  const indexedWorkspaceRepos = workspaceRepos.filter((repo) => repo.status === 'indexed');
  const indexedActiveRepos = activeRepos.filter((repo) => repo.status === 'indexed');

  const linkedRepoIds = new Set<string>();
  for (const item of scopeItems) {
    try {
      const link = await window.anvil.ba.getRepoLink(item.id);
      if (link) linkedRepoIds.add(link.repoId);
    } catch (error) {
      console.error(`Failed to resolve BA repo link for work item ${item.id}:`, error);
    }
  }

  if (linkedRepoIds.size > 0) {
    const linkedRepos = indexedWorkspaceRepos.filter((repo) => linkedRepoIds.has(repo.id));
    if (linkedRepos.length > 0) return linkedRepos;
  }

  const repoUrlMatches = new Set(
    scopeItems
      .map((item) => normalizeRepoUrl(item.repoUrl))
      .filter((value): value is string => Boolean(value)),
  );

  if (repoUrlMatches.size > 0) {
    const matchedRepos = indexedWorkspaceRepos.filter((repo) => {
      const repoUrl = repo.remoteUrl ? normalizeRepoUrl(repo.remoteUrl) : undefined;
      return repoUrl ? repoUrlMatches.has(repoUrl) : false;
    });
    if (matchedRepos.length > 0) return matchedRepos;
  }

  if (indexedActiveRepos.length > 0) {
    return indexedActiveRepos;
  }

  return indexedWorkspaceRepos;
}

function buildImpactAssessmentPrompt(
  rootItem: WorkItem,
  scopeItems: WorkItem[],
  repoNames: string[],
): string {
  const scopeInstruction =
    rootItem.type === 'Epic'
      ? 'This is an epic. Consider the epic itself and all child work items listed below as the proposed scope.'
      : 'This is a feature. Consider only this feature as the proposed scope.';

  const repoContext =
    repoNames.length > 0
      ? repoNames.map((name) => `- ${name}`).join('\n')
      : '- No indexed repository context was resolved.';

  const workItemDetails = scopeItems
    .map((item) => {
      const parts = [
        `Work Item: ${item.id}`,
        `Type: ${item.type}`,
        `Title: ${item.title}`,
        `State: ${item.state}`,
      ];

      if (item.assignee) parts.push(`Assignee: ${item.assignee}`);
      if (item.iterationPath) parts.push(`Iteration: ${item.iterationPath}`);
      if (item.tags && item.tags.length > 0) parts.push(`Tags: ${item.tags.join(', ')}`);

      const description = stripHtml(item.description);
      const acceptanceCriteria = stripHtml(item.acceptanceCriteria);
      if (description) parts.push(`Description:\n${description}`);
      if (acceptanceCriteria) parts.push(`Acceptance Criteria:\n${acceptanceCriteria}`);

      return parts.join('\n');
    })
    .join('\n\n---\n\n');

  return [
    'Please perform an impact assessment for this proposed change against the selected repository context.',
    scopeInstruction,
    '',
    'Focus on:',
    '- overlooked scope or hidden work',
    '- affected modules, services, APIs, data models, jobs, and integrations',
    '- side effects, regressions, and non-obvious downstream impacts',
    '- security, compliance, operational, performance, and observability concerns',
    '- dependencies, sequencing, rollout risks, and testing implications',
    '- missing acceptance criteria, assumptions, and follow-up questions',
    '- whether the scope should be split, re-framed, or de-risked before delivery',
    '',
    'Please structure the response with these headings:',
    '1. Scope Readout',
    '2. Likely Impact Areas',
    '3. Overlooked Work / Hidden Dependencies',
    '4. Risks and Side Effects',
    '5. Questions / Gaps to Clarify',
    '6. Recommended Next Steps',
    '',
    'Selected repositories:',
    repoContext,
    '',
    'Work item scope:',
    workItemDetails,
  ].join('\n');
}

function stripHtml(value?: string): string {
  if (!value) return '';

  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeRepoUrl(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}
