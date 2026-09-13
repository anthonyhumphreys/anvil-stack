import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TicketCheck,
  RefreshCw,
  AlertTriangle,
  Search,
  FileText,
  Play,
  ExternalLink,
  CheckCheck,
} from 'lucide-react';
import type { Iteration, RepoInfo, WorkItem, WorkItemConnection } from '../../../shared/types';
import {
  buildWorkItemIntent,
  extractAcceptanceCriteria,
  workItemText,
} from '../../../shared/workitem-intent';
import { SprintSelector } from './SprintSelector';
import { TagFilter } from './TagFilter';
import { WorkItemCard } from './WorkItemCard';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useChatContext } from '../../contexts/ChatContext';
import { EmptyState, InlineNotice, ViewHeader } from '../layout/ViewScaffold';
import { ChangeReviewPanel } from '../review/ChangeReviewPanel';

export function buildWorkItemTree(items: WorkItem[]): WorkItem[] {
  const map = new Map(items.map((item) => [item.id, { ...item, children: [] as WorkItem[] }]));
  const roots: WorkItem[] = [];
  for (const item of map.values()) {
    let parent = item.parentId;
    const seen = new Set([item.id]);
    let cycle = false;
    while (parent && map.has(parent)) {
      if (seen.has(parent)) {
        cycle = true;
        break;
      }
      seen.add(parent);
      parent = map.get(parent)?.parentId;
    }
    if (!cycle && item.parentId && map.has(item.parentId))
      map.get(item.parentId)!.children.push(item);
    else roots.push(item);
  }
  return roots;
}
const button =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';
export function WorkItemsView() {
  const navigate = useNavigate();
  const { activeWorkspace, featureAvailability, updatePreferences } = useWorkspace();
  const { activeRepos, launchPreparedChat } = useChatContext();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [selectedIterations, setSelectedIterations] = useState<string[]>([]);
  const [connections, setConnections] = useState<WorkItemConnection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [repoId, setRepoId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const request = useRef(0);
  const workspaceId = activeWorkspace?.id;
  const selected = items.find((item) => item.id === selectedId);
  const connection = connections.find((c) => c.id === connectionId);
  const repos = activeWorkspace?.repos ?? [];
  useEffect(() => {
    let cancelled = false;
    setSelectedId(undefined);
    setItems([]);
    setReviewing(false);
    setError(undefined);
    setRepoId(activeRepos[0]?.id ?? activeWorkspace?.repos[0]?.id ?? '');
    setSelectedTags([]);
    setStateFilter('');
    setFilter('');
    void window.anvil.settings
      .get()
      .then((settings) => {
        if (cancelled) return;
        setConnections(settings.workItemConnections ?? []);
        setConnectionId(
          activeWorkspace?.preferences?.workitems.workItemConnectionId ??
            settings.activeWorkItemConnectionId ??
            '',
        );
        setSelectedIterations(activeWorkspace?.preferences?.workitems.iterationIds ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
      request.current++;
    };
  }, [workspaceId]);
  const load = useCallback(async () => {
    const version = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const [nextItems, nextIterations] = await Promise.all([
        window.anvil.workitems.list(
          selectedIterations.length ? { iterationIds: selectedIterations } : undefined,
        ),
        window.anvil.workitems.listIterations(),
      ]);
      if (version !== request.current) return;
      setItems(nextItems);
      setIterations(nextIterations);
    } catch (err) {
      if (version === request.current)
        setError(err instanceof Error ? err.message : 'Could not load Work Items. Try refreshing.');
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [connectionId, selectedIterations, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function switchConnection(id: string) {
    setBusy(true);
    request.current++;
    setSelectedId(undefined);
    setReviewing(false);
    setItems([]);
    try {
      await updatePreferences({
        workitems: { workItemConnectionId: id, iterationIds: [], iterationNames: [] },
      });
      await window.anvil.settings.update({ activeWorkItemConnectionId: id });
      setSelectedIterations([]);
      setSelectedTags([]);
      setConnectionId(id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  async function changeIterations(ids: string[]) {
    setSelectedIterations(ids);
    try {
      await updatePreferences({
        workitems: {
          iterationIds: ids,
          iterationNames: ids.map((id) => iterations.find((i) => i.id === id)?.name ?? id),
        },
      });
    } catch (err) {
      setError(String(err));
    }
  }
  async function launch(mode: 'plan' | 'implement' | 'impact') {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const fresh = await window.anvil.workitems.get(selected.id, connectionId, true);
      setItems((items) => items.map((item) => (item.id === fresh.id ? fresh : item)));
      let targetRepos = repos.filter((repo) => repo.id === repoId);
      let message = mode === 'impact' ? '' : buildWorkItemIntent(fresh, mode);
      if (mode === 'impact') {
        const scope = getImpactScopeItems(fresh, items);
        targetRepos = await resolveImpactAssessmentRepos(scope, activeRepos, repos);
        message = buildImpactAssessmentPrompt(
          fresh,
          scope,
          targetRepos.map((repo) => repo.name),
        );
      }
      await launchPreparedChat({
        personaId: mode === 'impact' ? 'ba' : 'coder',
        repoIds: targetRepos.map((repo) => repo.id),
        message,
        collaborationMode: mode === 'implement' ? 'default' : 'plan',
        workItem: fresh,
        threadTitle: `${mode === 'plan' ? 'Plan' : mode === 'implement' ? 'Implement' : 'Impact'}: ${fresh.title}`,
      });
      navigate('/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start work.');
    } finally {
      setBusy(false);
    }
  }
  const tags = useMemo(
    () => [...new Set(items.flatMap((item) => item.tags ?? []))].sort(),
    [items],
  );
  const states = useMemo(() => [...new Set(items.map((item) => item.state))].sort(), [items]);
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return items.filter(
      (item) =>
        (!query ||
          `${item.id} ${item.title} ${item.type} ${item.assignee ?? ''}`
            .toLowerCase()
            .includes(query)) &&
        (!stateFilter || item.state === stateFilter) &&
        selectedTags.every((tag) => item.tags?.includes(tag)),
    );
  }, [items, filter, stateFilter, selectedTags]);
  const tree = useMemo(() => buildWorkItemTree(filtered), [filtered]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        icon={TicketCheck}
        title="Work Items"
        description="Choose the work, decide how to approach it, then review the evidence."
        actions={
          <>
            <button className={button} onClick={() => navigate('/review')}>
              Local review
            </button>
            <select
              aria-label="Work item connection"
              value={connectionId}
              onChange={(e) => void switchConnection(e.target.value)}
              disabled={busy}
              className={button}
            >
              {!connections.length ? <option value="">No connections</option> : null}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className={button} onClick={() => void load()} disabled={loading || busy}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </>
        }
      />
      {error ? (
        <InlineNotice icon={AlertTriangle} tone="error" className="mx-4 my-2">
          {error}
        </InlineNotice>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          aria-label="Work item list"
          className={`${selected ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col lg:w-[38%] lg:min-w-72 lg:max-w-lg lg:border-r border-border`}
        >
          <div className="space-y-3 border-b border-border p-4">
            <label className="relative block">
              <span className="sr-only">Search work items</span>
              <Search size={16} className="absolute left-3 top-2.5 text-text-tertiary" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search ID, title or assignee"
                className="w-full rounded-md border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-accent"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <SprintSelector
                iterations={iterations}
                selected={selectedIterations}
                onChange={(ids) => void changeIterations(ids)}
                label={connection?.provider === 'linear' ? 'Cycle' : 'Sprint'}
              />
              <select
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className={button}
              >
                <option value="">All states</option>
                {states.map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
            </div>
            <TagFilter allTags={tags} selected={selectedTags} onChange={setSelectedTags} />
            <p className="text-xs text-text-tertiary" aria-live="polite">
              {loading ? 'Refreshing work items…' : `${filtered.length} of ${items.length} items`}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && !items.length ? (
              <p className="p-6 text-sm text-text-secondary" role="status">
                Loading work items…
              </p>
            ) : tree.length ? (
              tree.map((item) => (
                <WorkItemCard
                  key={item.id}
                  item={item}
                  depth={0}
                  activeId={selectedId}
                  onSelect={(item) => {
                    setSelectedId(item.id);
                    setReviewing(false);
                  }}
                />
              ))
            ) : (
              <EmptyState
                icon={TicketCheck}
                title={connections.length ? 'No matching work items' : 'Connect your work tracker'}
                description={
                  connections.length
                    ? 'Adjust the search, state or iteration filters.'
                    : 'Add Azure DevOps, Linear or Jira in Settings to bring your work here.'
                }
              />
            )}
          </div>
        </section>
        <section
          aria-label="Work item detail"
          className={`${selected ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-1 flex-col overflow-auto`}
        >
          {selected ? (
            <>
              <div className="space-y-4 border-b border-border p-5">
                <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
                  <button
                    className={`${button} lg:hidden`}
                    onClick={() => setSelectedId(undefined)}
                  >
                    Back to items
                  </button>
                  <span>{selected.id}</span>
                  <span>{selected.type}</span>
                  <span>{selected.state}</span>
                  {selected.url && /^https?:\/\//i.test(selected.url) ? (
                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 text-accent"
                    >
                      Open source
                      <ExternalLink size={14} />
                    </a>
                  ) : null}
                </div>
                <h2 className="break-words text-xl font-semibold leading-7 text-text-primary">
                  {selected.title}
                </h2>
                <p className="text-sm text-text-secondary">
                  {selected.assignee || 'Unassigned'}
                  {selected.iterationPath ? ` · ${selected.iterationPath}` : ''}
                </p>
                <label className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
                  Repository
                  <select
                    value={repoId}
                    onChange={(e) => {
                      setRepoId(e.target.value);
                      setReviewing(false);
                    }}
                    className={`${button} min-w-0 max-w-full`}
                  >
                    <option value="">Choose repository</option>
                    {repos.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`${button.replace('text-text-primary', 'text-bg-primary')} border-accent bg-accent hover:bg-accent/90`}
                    disabled={busy || !repoId}
                    onClick={() => void launch('implement')}
                  >
                    <Play size={15} />
                    Implement
                  </button>
                  <button
                    className={button}
                    disabled={busy || !repoId}
                    onClick={() => void launch('plan')}
                  >
                    <FileText size={15} />
                    Plan first
                  </button>
                  <button
                    className={button}
                    disabled={!repoId || busy}
                    onClick={() => setReviewing((value) => !value)}
                  >
                    <CheckCheck size={15} />
                    {reviewing ? 'Show task' : 'Review change'}
                  </button>
                </div>
                <p className="max-w-prose text-xs leading-5 text-text-tertiary">
                  Plan first explores the approach and waits for approval. Implement proceeds with
                  the work, asking for a decision when scope or risk needs your input.
                </p>
              </div>
              {reviewing && workspaceId ? (
                <ChangeReviewPanel
                  key={`${workspaceId}:${connectionId}:${selected.id}:${repoId}`}
                  workspaceId={workspaceId}
                  repoId={repoId}
                  workItem={selected}
                  connectionId={connectionId}
                />
              ) : (
                <div className="space-y-6 p-5">
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">Acceptance criteria</h3>
                    <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">
                      {extractAcceptanceCriteria(selected) ||
                        'No explicit acceptance criteria in this item. Confirm the expectations when planning; inferred criteria are not approved requirements.'}
                    </p>
                    <p className="mt-2 text-xs text-text-tertiary">
                      Maintained in {connection?.name ?? selected.provider}. Refreshed before
                      starting work or accepting a review.
                    </p>
                  </section>
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">Description</h3>
                    <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">
                      {workItemText(selected.description) || 'No description provided.'}
                    </p>
                  </section>
                  {selected.tags?.length ? (
                    <p className="text-xs text-text-tertiary">Tags: {selected.tags.join(', ')}</p>
                  ) : null}
                  <details className="text-sm">
                    <summary className="cursor-pointer text-text-secondary">
                      Explore this work
                    </summary>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(['issue-investigation', 'change-preparation'] as const).map((preset) => (
                        <button
                          key={preset}
                          className={button}
                          disabled={!featureAvailability.repoFeaturesEnabled}
                          onClick={() =>
                            navigate(
                              `/workflows?${new URLSearchParams({
                                preset,
                                workItemId: selected.id,
                                workItemProvider: selected.provider,
                                workItemConnection: connectionId,
                                kickoff: [
                                  `Work item: ${selected.id} — ${selected.title}`,
                                  `Provider: ${selected.provider}`,
                                  `Description: ${workItemText(selected.description)}`,
                                  `Acceptance criteria: ${extractAcceptanceCriteria(selected) || 'Not supplied'}`,
                                ].join('\n'),
                              })}`,
                            )
                          }
                        >
                          {preset === 'issue-investigation'
                            ? 'Investigate with a workflow'
                            : 'Prepare a change workflow'}
                        </button>
                      ))}
                      <button
                        className={button}
                        onClick={() => navigate(`/ba/${encodeURIComponent(selected.id)}`)}
                      >
                        Discuss requirements
                      </button>
                      <button
                        className={button}
                        disabled={busy || !featureAvailability.repoFeaturesEnabled}
                        onClick={() => void launch('impact')}
                      >
                        Assess impact
                      </button>
                    </div>
                  </details>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              icon={TicketCheck}
              title="Choose a work item"
              description="Read its criteria, plan or implement the change, and review the resulting evidence here."
            />
          )}
        </section>
      </div>
    </div>
  );
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
