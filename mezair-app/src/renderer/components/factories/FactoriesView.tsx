import {
  CircleAlert,
  CheckCircle2,
  Hand,
  KeyRound,
  Lock,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  factoryWorkflowDrift,
  type FactoryDefinition,
  type FactoryDefinitionInput,
  type FactoryDirectoryItem,
  type FactoryOrganizationOption,
  type FactoryPreview,
  type FactoryRun,
  type FactoryRunControlInput,
} from '../../../shared/factories';
import type { Persona, WorkflowTemplate } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { IconButton } from '../ui/IconButton';
import { Menu, MenuItem } from '../ui/Menu';
import { SegmentedControl } from '../ui/SegmentedControl';
import { cx } from '../ui/cx';
import {
  canManageFactory,
  canOperateFactory,
  canReadFactorySource,
  canReadRunSource,
  effectiveFactoryRole,
} from './factory-ui-policy';
import { recipientPickupThread, takeoverControlInput } from './factory-pickup';
import { DRAFT_EXAMPLES, githubIdentity, isGithubRepo, newDefinition } from './factory-definition';
import {
  FACTORY_STATIONS,
  groupRuns,
  relativeTime,
  runPosition,
  stationLoads,
  stationOf,
  summarizeRuns,
  type FactoryRunSummary,
  type FactoryStationId,
  type RunGroup,
} from './factory-line';
import { LiveGlyph, RUN_STATE_META, RunStateIcon, RunTrack, StationBoard } from './FactoryLine';
import { FactoryRunDetail, type TakeoverContext } from './FactoryRunDetail';
import { FactoryEditor } from './FactoryEditor';
import { FactoryAuthority } from './FactoryAuthority';
import { FactoryDefinitionPanel } from './FactoryDefinitionPanel';
import { FactoryStatus, Mono, Notice, factoryStatusKey } from './FactoryPrimitives';

interface Banner {
  tone: 'error' | 'notice';
  text: string;
  action?: { label: string; onClick: () => void };
}

const GROUP_LABELS: Record<RunGroup, string> = {
  attention: 'Needs you',
  active: 'In progress',
  finished: 'Finished',
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function FactoriesView() {
  const { activeWorkspace, repos, workspaces } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = useNow(15_000);
  const [loaded, setLoaded] = useState(false);
  const [factories, setFactories] = useState<FactoryDefinition[]>([]);
  const [organizations, setOrganizations] = useState<FactoryOrganizationOption[]>([]);
  const [directory, setDirectory] = useState<FactoryDirectoryItem[]>([]);
  const [keyRegistrationBusy, setKeyRegistrationBusy] = useState<string | null>(null);
  const [runs, setRuns] = useState<FactoryRun[]>([]);
  const [runSummaries, setRunSummaries] = useState<Record<string, FactoryRunSummary>>({});
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedFactoryId, setSelectedFactoryId] = useState<string | null>(
    searchParams.get('factory'),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(searchParams.get('run'));
  const [runsFactoryId, setRunsFactoryId] = useState<string | null>(null);
  const [runsLoadedAt, setRunsLoadedAt] = useState<number | null>(null);
  const [tab, setTab] = useState<'runs' | 'definition'>('runs');
  const [stationFilter, setStationFilter] = useState<FactoryStationId | null>(null);
  const [editingFactoryId, setEditingFactoryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FactoryDefinitionInput | null>(null);
  const [preview, setPreview] = useState<FactoryPreview | null>(null);
  const [repinWorkflow, setRepinWorkflow] = useState(false);
  const [request, setRequest] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftedFromRequest, setDraftedFromRequest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingCopy, setSavingCopy] = useState(false);
  const [activating, setActivating] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [activationPreview, setActivationPreview] = useState<FactoryPreview | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const selectedFactoryRef = useRef(selectedFactoryId);
  const selectedRunRef = useRef(selectedRunId);
  const runsFactoryRef = useRef<string | null>(null);
  const draftOpenRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const runGenerationRef = useRef(0);
  const workspaceIdRef = useRef(activeWorkspace?.id);
  const previousWorkspaceIdRef = useRef(activeWorkspace?.id);
  // Read at load time so selecting a run (a URL change) never triggers a full reload.
  const searchParamsRef = useRef(searchParams);
  workspaceIdRef.current = activeWorkspace?.id;
  searchParamsRef.current = searchParams;

  const setError = useCallback(
    (text: string | null) => setBanner(text ? { tone: 'error', text } : null),
    [],
  );
  const setNotice = (text: string, action?: Banner['action']) =>
    setBanner({ tone: 'notice', text, action });

  const selectedFactory = factories.find((item) => item.id === selectedFactoryId) ?? null;
  const factoryRuns = runsFactoryId === selectedFactoryId ? runs : [];
  const selectedRun = factoryRuns.find((item) => item.id === selectedRunId) ?? null;
  const githubRepos = useMemo(() => repos.filter(isGithubRepo), [repos]);

  useEffect(() => {
    window.mezair.chat
      .getPersonas()
      .then(setPersonas)
      .catch(() => setPersonas([]));
  }, []);

  const loadRuns = useCallback(
    async (factoryId: string) => {
      const generation = ++runGenerationRef.current;
      // Only clear when switching factories; polling must not blank the list.
      if (runsFactoryRef.current !== factoryId) {
        setRuns([]);
        setRunsLoadedAt(null);
      }
      runsFactoryRef.current = factoryId;
      setRunsFactoryId(factoryId);
      try {
        const nextRuns = await window.mezair.factories.listRuns(factoryId);
        if (generation !== runGenerationRef.current || selectedFactoryRef.current !== factoryId)
          return;
        setRuns(nextRuns);
        setRunsLoadedAt(Date.now());
        setRunSummaries((current) => ({ ...current, [factoryId]: summarizeRuns(nextRuns) }));
        const runId = selectedRunRef.current;
        if (!runId || !nextRuns.some((item) => item.id === runId)) {
          const groups = groupRuns(nextRuns);
          const firstRunId =
            [...groups.attention, ...groups.active, ...groups.finished][0]?.id ?? null;
          selectedRunRef.current = firstRunId;
          setSelectedRunId(firstRunId);
        }
      } catch (cause) {
        if (generation !== runGenerationRef.current || selectedFactoryRef.current !== factoryId)
          return;
        setRuns([]);
        setRunsFactoryId(null);
        runsFactoryRef.current = null;
        selectedRunRef.current = null;
        setSelectedRunId(null);
        setError(
          cause instanceof Error
            ? cause.message
            : 'Run access changed. Reload after permissions are restored.',
        );
      }
    },
    [setError],
  );

  const reload = useCallback(async () => {
    const workspaceId = activeWorkspace?.id;
    if (!workspaceId) return;
    const generation = ++loadGenerationRef.current;
    try {
      const [items, savedTemplates] = await Promise.all([
        window.mezair.factories.list(workspaceId),
        window.mezair.workflow.listTemplates(),
      ]);
      if (generation !== loadGenerationRef.current) return;
      setFactories(items);
      setTemplates(savedTemplates);
      void window.mezair.factories
        .listOrganizations()
        .then(async (orgs) => {
          if (generation !== loadGenerationRef.current) return;
          setOrganizations(orgs);
          const entries = await Promise.all(
            orgs.map((org) => window.mezair.factories.directory(org.id).catch(() => [])),
          );
          if (generation === loadGenerationRef.current) setDirectory(entries.flat());
        })
        .catch(() => {
          if (generation === loadGenerationRef.current) {
            setOrganizations([]);
            setDirectory([]);
          }
        });
      const requestedId = searchParamsRef.current.get('factory');
      const currentId = selectedFactoryRef.current;
      const targetId = items.some((item) => item.id === requestedId)
        ? requestedId
        : items.some((item) => item.id === currentId)
          ? currentId
          : (items[0]?.id ?? null);
      // Attention counts for every factory in the rail; the selected one refreshes with its runs.
      void Promise.all(
        items
          .filter((item) => !item.accessPending && item.id !== targetId)
          .map((item) =>
            window.mezair.factories
              .listRuns(item.id)
              .then((list) => [item.id, summarizeRuns(list)] as const)
              .catch(() => null),
          ),
      ).then((entries) => {
        if (generation !== loadGenerationRef.current) return;
        setRunSummaries((current) => ({
          ...Object.fromEntries(
            Object.entries(current).filter(([id]) => items.some((item) => item.id === id)),
          ),
          ...Object.fromEntries(entries.filter((entry) => entry !== null)),
        }));
      });
      if (draftOpenRef.current) return;
      selectedFactoryRef.current = targetId;
      setSelectedFactoryId(targetId);
      if (!targetId) {
        setRuns([]);
        setRunsFactoryId(null);
        runsFactoryRef.current = null;
        selectedRunRef.current = null;
        setSelectedRunId(null);
        return;
      }
      await loadRuns(targetId);
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setFactories([]);
      setRuns([]);
      setRunsFactoryId(null);
      setError(cause instanceof Error ? cause.message : 'Could not load software factories.');
    } finally {
      if (generation === loadGenerationRef.current) setLoaded(true);
    }
  }, [activeWorkspace?.id, loadRuns, setError]);

  const registerOrganizationKey = async (organizationId: string) => {
    setKeyRegistrationBusy(organizationId);
    setBanner(null);
    try {
      await window.mezair.factories.registerOrganizationKey(organizationId);
      setNotice(
        'Encryption key enrolled. If this account was added after the factory was shared, ask its owner to publish the current revision again.',
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not enroll this account for organization factory access.',
      );
    } finally {
      setKeyRegistrationBusy(null);
    }
  };

  const closeEditor = () => {
    draftOpenRef.current = false;
    setEditingFactoryId(null);
    setDraft(null);
    setPreview(null);
    setRepinWorkflow(false);
    setDraftedFromRequest(false);
  };

  useEffect(() => {
    if (previousWorkspaceIdRef.current !== activeWorkspace?.id) {
      setBanner(null);
      // A draft belongs to the workspace in which it was composed. Never let a
      // late response or an open editor bleed into another workspace.
      previousWorkspaceIdRef.current = activeWorkspace?.id;
      closeEditor();
      setActivationPreview(null);
      setRunSummaries({});
      selectedFactoryRef.current = null;
      selectedRunRef.current = null;
    }
    reload().catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Could not load software factories.'),
    );
  }, [activeWorkspace?.id, reload, setError]);

  useEffect(() => {
    if (!selectedFactoryId || !activeWorkspace?.id) return;
    const timer = window.setInterval(() => {
      void loadRuns(selectedFactoryId);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [selectedFactoryId, activeWorkspace?.id, loadRuns]);

  const startNew = useCallback(
    (workflowTemplateId = '') => {
      if (!activeWorkspace?.id) return;
      draftOpenRef.current = true;
      selectedFactoryRef.current = null;
      selectedRunRef.current = null;
      setSelectedFactoryId(null);
      setSelectedRunId(null);
      setEditingFactoryId(null);
      setDraft(newDefinition(activeWorkspace.id, githubRepos[0] ?? repos[0], workflowTemplateId));
      setPreview(null);
      setRepinWorkflow(false);
      setDraftedFromRequest(false);
      setActivationPreview(null);
      setRuns([]);
      runsFactoryRef.current = null;
      setSearchParams({}, { replace: true });
      setBanner(null);
    },
    [activeWorkspace?.id, githubRepos, repos, setSearchParams],
  );

  useEffect(() => {
    if (!activeWorkspace?.id) return;
    if (searchParams.get('new') !== null) {
      startNew(searchParams.get('workflow') ?? '');
      return;
    }
    const selectedId = searchParams.get('factory');
    const runId = searchParams.get('run');
    if (runId && !selectedId) {
      // Deep links from Workflows know the run, not its factory.
      window.mezair.factories
        .getRun(runId)
        .then((run) => {
          if (workspaceIdRef.current !== activeWorkspace.id) return;
          if (!run) throw new Error('That factory run is not available to this account.');
          setSearchParams({ factory: run.factoryId, run: run.id }, { replace: true });
        })
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not open that factory run.'),
        );
      return;
    }
    if (selectedId && selectedId !== selectedFactoryRef.current) {
      closeEditor();
      setTab('runs');
      setStationFilter(null);
      selectedFactoryRef.current = selectedId;
      setSelectedFactoryId(selectedId);
      void loadRuns(selectedId);
    }
    if (runId && runId !== selectedRunRef.current) {
      selectedRunRef.current = runId;
      setSelectedRunId(runId);
      setTab('runs');
    }
  }, [searchParams, activeWorkspace?.id, loadRuns, startNew, setSearchParams, setError]);

  const setDefinition = (update: (current: FactoryDefinitionInput) => FactoryDefinitionInput) => {
    setDraft((current) => (current ? update(current) : current));
    setPreview(null);
    setActivationPreview(null);
    setBanner(null);
  };

  const chooseFactory = (factory: FactoryDefinition) => {
    closeEditor();
    selectedFactoryRef.current = factory.id;
    selectedRunRef.current = null;
    setSelectedFactoryId(factory.id);
    setSelectedRunId(null);
    setActivationPreview(null);
    setTab('runs');
    setStationFilter(null);
    setSearchParams({ factory: factory.id }, { replace: true });
    void loadRuns(factory.id);
  };

  const selectRun = (run: FactoryRun) => {
    selectedRunRef.current = run.id;
    setSelectedRunId(run.id);
    setSearchParams({ factory: run.factoryId, run: run.id }, { replace: true });
  };

  const startConversationalDraft = async () => {
    if (!activeWorkspace?.id || !request.trim()) return;
    const workspaceId = activeWorkspace.id;
    setDraftBusy(true);
    draftOpenRef.current = true;
    setEditingFactoryId(null);
    selectedFactoryRef.current = null;
    setBanner(null);
    try {
      const proposed = await window.mezair.factories.draft(request.trim(), workspaceId);
      if (workspaceIdRef.current !== workspaceId) return;
      if (
        proposed.workspaceId !== workspaceId ||
        !repos.some((repo) => repo.id === proposed.repoId)
      )
        throw new Error(
          'The draft selected a repository outside this workspace. Choose an in-scope repository and retry.',
        );
      selectedFactoryRef.current = null;
      selectedRunRef.current = null;
      setDraft(proposed);
      setPreview(null);
      setDraftedFromRequest(true);
      setSelectedFactoryId(null);
      setSelectedRunId(null);
      setRuns([]);
      setSearchParams({}, { replace: true });
    } catch (cause) {
      if (workspaceIdRef.current !== workspaceId) return;
      setError(cause instanceof Error ? cause.message : 'Could not draft a factory.');
    } finally {
      setDraftBusy(false);
    }
  };

  const updateRepo = (repoId: string) => {
    const repo = repos.find((item) => item.id === repoId);
    if (!repo) return;
    setDefinition((current) => ({
      ...current,
      repoId,
      github: { ...githubIdentity(repo), label: current.github.label },
    }));
  };

  const makePreview = async (definition: FactoryDefinitionInput) => {
    setSaving(true);
    setBanner(null);
    try {
      if (definition.access.kind === 'organization' && definition.access.visibility === 'team') {
        if (!definition.access.teamId?.trim())
          throw new Error('Choose a GitHub team slug for team visibility.');
        const valid = await window.mezair.factories.validateOrganizationTeam(
          definition.access.organizationId,
          { host: 'github.com', owner: definition.github.owner, repo: definition.github.repo },
          definition.access.teamId.trim(),
        );
        if (!valid)
          throw new Error('The selected GitHub team is not authorized for this repository.');
      }
      setPreview(
        await window.mezair.factories.preview(
          definition,
          editingFactoryId ?? undefined,
          repinWorkflow ? { repinWorkflow } : undefined,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Factory definition could not be validated.',
      );
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft || !preview) return;
    setSaving(true);
    setBanner(null);
    try {
      const saved = await window.mezair.factories.save({
        definition: preview.definition,
        confirmation: preview.confirmation,
        ...(editingFactoryId && selectedFactory
          ? { id: editingFactoryId, expectedRevision: selectedFactory.revision }
          : {}),
        ...(repinWorkflow ? { repinWorkflow } : {}),
      });
      closeEditor();
      selectedFactoryRef.current = saved.id;
      selectedRunRef.current = null;
      setFactories((current) =>
        current.some((item) => item.id === saved.id)
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...current],
      );
      setSelectedFactoryId(saved.id);
      setTab('runs');
      setSearchParams({ factory: saved.id }, { replace: true });
      void loadRuns(saved.id);
      setNotice(
        saved.status === 'active'
          ? `Revision ${saved.revision} saved. Revision ${saved.activeRevision} keeps processing issues until you activate this one.`
          : 'Draft saved. It will not process issues until you activate it.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Factory draft could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const prepareActivation = async () => {
    if (!selectedFactory) return;
    setActivating(true);
    setBanner(null);
    try {
      const exact = await window.mezair.factories.get(selectedFactory.id);
      if (!exact || exact.revision !== selectedFactory.revision)
        throw new Error(
          'Factory changed. Reload and review its latest revision before activation.',
        );
      setActivationPreview(await window.mezair.factories.preview(exact.definition, exact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare factory activation.');
    } finally {
      setActivating(false);
    }
  };

  const confirmActivation = async () => {
    if (!selectedFactory || !activationPreview) return;
    setActivating(true);
    setBanner(null);
    try {
      const current = await window.mezair.factories.get(selectedFactory.id);
      if (!current || current.revision !== selectedFactory.revision)
        throw new Error('Factory changed after review. Reload and review the latest revision.');
      const activated = await window.mezair.factories.activate({
        factoryId: current.id,
        revision: current.revision,
        confirmation: activationPreview.confirmation,
      });
      setFactories((items) => items.map((item) => (item.id === activated.id ? activated : item)));
      setActivationPreview(null);
      setNotice('Factory activated. Matching issues are processed under this reviewed policy.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not activate factory.');
    } finally {
      setActivating(false);
    }
  };

  const doFactoryAction = async (action: 'pause' | 'resume' | 'deactivate') => {
    if (!selectedFactory) return;
    setBusyAction(action);
    setBanner(null);
    try {
      const updated = await window.mezair.factories.control({
        factoryId: selectedFactory.id,
        action,
      });
      setFactories((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setActivationPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} factory.`);
    } finally {
      setBusyAction(null);
      setConfirmDeactivate(false);
    }
  };

  const doRunAction = async (
    action: FactoryRunControlInput['action'],
    context?: TakeoverContext,
  ): Promise<boolean> => {
    if (!selectedRun) return false;
    setBusyAction(action);
    setBanner(null);
    try {
      const controlInput =
        action === 'takeover' && context
          ? takeoverControlInput(selectedRun.id, context)
          : { runId: selectedRun.id, action };
      const updated = await window.mezair.factories.controlRun({
        ...controlInput,
        ...(action === 'approve-merge' && selectedRun.observation?.headSha
          ? { expectedHeadSha: selectedRun.observation.headSha }
          : {}),
      });
      setRuns((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      selectedRunRef.current = updated.id;
      setSelectedRunId(updated.id);
      const pickupThreadId = action === 'takeover' ? recipientPickupThread(updated) : null;
      if (pickupThreadId && context) {
        navigate(
          `/chat?thread=${encodeURIComponent(pickupThreadId)}&persona=${encodeURIComponent(context.personaId)}`,
        );
      } else if (action === 'takeover') {
        setNotice(
          'Run claimed for pickup. The private chat appears here once the owner’s device confirms.',
        );
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} issue run.`);
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const openEditor = (repin = false, workflowTemplateId?: string) => {
    if (!selectedFactory) return;
    draftOpenRef.current = true;
    setEditingFactoryId(selectedFactory.id);
    setDraft({
      ...structuredClone(selectedFactory.definition),
      ...(workflowTemplateId ? { workflowTemplateId } : {}),
    });
    setPreview(null);
    setRepinWorkflow(repin);
    setActivationPreview(null);
    setBanner(null);
  };

  const saveWorkflowCopy = async () => {
    if (!selectedFactory) return;
    const pinned = selectedFactory.workflow;
    const missing = !templates.some(
      (item) => item.id === selectedFactory.definition.workflowTemplateId,
    );
    setSavingCopy(true);
    setBanner(null);
    try {
      const saved = await window.mezair.workflow.saveTemplate({
        name: missing
          ? pinned.name
          : `${pinned.name} (pinned in revision ${selectedFactory.revision})`,
        description: pinned.description,
        nodes: pinned.nodes,
        edges: pinned.edges,
        orchestration: pinned.orchestration,
      });
      setTemplates((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setNotice(
        missing ? `Restored “${saved.name}” to Workflows.` : `Saved “${saved.name}” to Workflows.`,
        {
          label: 'Open in Workflows',
          onClick: () => navigate(`/workflows?template=${encodeURIComponent(saved.id)}`),
        },
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save the pinned graph as a workflow.',
      );
    } finally {
      setSavingCopy(false);
    }
  };

  if (!activeWorkspace) {
    return (
      <div className="p-8 text-sm text-text-secondary">Choose a workspace to manage factories.</div>
    );
  }

  const editingFactory = editingFactoryId ? selectedFactory : null;
  const pendingDirectory = directory.filter((item) => item.accessPending || item.accessRequired);

  return (
    <div className="flex h-full min-h-0 bg-bg-primary">
      <FactoryRail
        factories={factories}
        loaded={loaded}
        selectedId={draft && !editingFactoryId ? null : selectedFactoryId}
        creating={Boolean(draft && !editingFactoryId)}
        summaries={runSummaries}
        pendingDirectory={pendingDirectory}
        keyRegistrationBusy={keyRegistrationBusy}
        onSelect={chooseFactory}
        onNew={() => startNew()}
        onRegisterKey={(id) => void registerOrganizationKey(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {banner && (
          <div
            role={banner.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'flex shrink-0 items-start gap-2.5 border-b px-6 py-2.5 text-sm',
              banner.tone === 'error'
                ? 'border-error/30 bg-error/[0.07] text-text-primary'
                : 'border-success/25 bg-success/[0.06] text-text-primary',
            )}
          >
            {banner.tone === 'error' ? (
              <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-error" />
            ) : (
              <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
            )}
            <span className="min-w-0 flex-1">{banner.text}</span>
            {banner.action && (
              <button
                type="button"
                className="shrink-0 text-sm text-text-secondary underline decoration-border underline-offset-4 hover:text-text-primary"
                onClick={banner.action.onClick}
              >
                {banner.action.label}
              </button>
            )}
            <IconButton icon={X} label="Dismiss" onClick={() => setBanner(null)} />
          </div>
        )}

        {draft ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FactoryEditor
              draft={draft}
              editing={editingFactory}
              templates={templates}
              repos={githubRepos.length ? githubRepos : repos}
              organizations={organizations}
              preview={preview}
              busy={saving}
              repinWorkflow={repinWorkflow}
              request={request}
              drafting={draftBusy}
              draftedFromRequest={draftedFromRequest}
              onRequest={setRequest}
              onDraftFromRequest={() => void startConversationalDraft()}
              onDefinition={setDefinition}
              onRepo={updateRepo}
              onRepin={(value) => {
                setRepinWorkflow(value);
                setPreview(null);
              }}
              onPreview={(definition) => void makePreview(definition)}
              onSave={() => void saveDraft()}
              onCancel={() => {
                closeEditor();
                void reload();
              }}
            />
          </div>
        ) : selectedFactory ? (
          <FactoryFloor
            factory={selectedFactory}
            runs={factoryRuns}
            runsLoaded={runsLoadedAt !== null}
            runsLoadedAt={runsLoadedAt}
            selectedRun={selectedRun}
            templates={templates}
            tab={tab}
            stationFilter={stationFilter}
            activationPreview={activationPreview}
            activating={activating}
            busyAction={busyAction}
            savingCopy={savingCopy}
            now={now}
            personas={personas}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspace.id}
            onTab={setTab}
            onStationFilter={setStationFilter}
            onRefresh={() => void loadRuns(selectedFactory.id)}
            onSelectRun={selectRun}
            onRunAction={doRunAction}
            onEdit={() => openEditor(false)}
            onRepin={() => openEditor(true)}
            onPrepareActivation={() => void prepareActivation()}
            onConfirmActivation={() => void confirmActivation()}
            onCancelActivation={() => setActivationPreview(null)}
            onFactoryAction={(action) =>
              action === 'deactivate' ? setConfirmDeactivate(true) : void doFactoryAction(action)
            }
            onOpenThread={(threadId, personaId) =>
              navigate(
                `/chat?thread=${encodeURIComponent(threadId)}${personaId ? `&persona=${encodeURIComponent(personaId)}` : ''}`,
              )
            }
            onOpenWorkflowRun={(runId) => navigate(`/workflows?run=${encodeURIComponent(runId)}`)}
            onOpenTemplate={(templateId) =>
              navigate(`/workflows?template=${encodeURIComponent(templateId)}`)
            }
            onSaveWorkflowCopy={() => void saveWorkflowCopy()}
            onLinkTemplate={(templateId) => openEditor(false, templateId)}
          />
        ) : loaded && factories.length === 0 ? (
          <EmptyFactories
            onStart={(text) => {
              setRequest(text);
              startNew();
            }}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-sm text-text-tertiary">
            {loaded ? 'Choose a factory to see its line.' : ''}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={confirmDeactivate}
        title="Deactivate this factory?"
        description="No new issues will be claimed. Runs already in progress keep their recorded policy and stay controllable."
        confirmLabel="Deactivate"
        cancelLabel="Keep active"
        tone="danger"
        loading={busyAction === 'deactivate'}
        onCancel={() => setConfirmDeactivate(false)}
        onConfirm={() => void doFactoryAction('deactivate')}
      />
    </div>
  );
}

function FactoryRail({
  factories,
  loaded,
  selectedId,
  creating,
  summaries,
  pendingDirectory,
  keyRegistrationBusy,
  onSelect,
  onNew,
  onRegisterKey,
}: {
  factories: FactoryDefinition[];
  loaded: boolean;
  selectedId: string | null;
  creating: boolean;
  summaries: Record<string, FactoryRunSummary>;
  pendingDirectory: FactoryDirectoryItem[];
  keyRegistrationBusy: string | null;
  onSelect: (factory: FactoryDefinition) => void;
  onNew: () => void;
  onRegisterKey: (organizationId: string) => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-4">
        <h1 className="text-sm font-semibold text-text-primary">Factories</h1>
        <IconButton icon={Plus} label="New factory" size="md" variant="secondary" onClick={onNew} />
      </div>
      <nav aria-label="Factories" className="min-h-0 flex-1 overflow-y-auto p-2">
        {!loaded && (
          <div className="space-y-2 p-2" aria-hidden="true">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-12 animate-pulse rounded-lg bg-bg-tertiary/60 motion-reduce:animate-none"
              />
            ))}
          </div>
        )}
        {creating && (
          <div className="mb-1 flex items-center gap-2.5 rounded-lg bg-accent/[0.08] px-3 py-2.5 text-sm font-medium text-text-primary ring-1 ring-accent/30 ring-inset">
            <Sparkles size={14} aria-hidden="true" className="text-accent" />
            New factory
          </div>
        )}
        <ul className="space-y-0.5">
          {factories.map((factory) => {
            const summary = summaries[factory.id];
            const selected = selectedId === factory.id;
            const source = canReadFactorySource(factory)
              ? `${factory.definition.github.owner}/${factory.definition.github.repo}`
              : 'Source hidden';
            return (
              <li key={factory.id}>
                <button
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => onSelect(factory)}
                  className={cx(
                    'w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                    selected
                      ? 'bg-accent/[0.08] ring-1 ring-accent/30 ring-inset'
                      : 'hover:bg-bg-tertiary',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <FactoryStatus status={factoryStatusKey(factory)} iconOnly />
                    <span
                      className={cx(
                        'min-w-0 flex-1 truncate text-sm font-medium',
                        selected ? 'text-text-primary' : 'text-text-secondary',
                      )}
                    >
                      {factory.accessPending ? 'Shared factory' : factory.definition.name}
                    </span>
                    {summary?.attention ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-semibold text-warning tabular-nums"
                        title={`${summary.attention} ${summary.attention === 1 ? 'run needs' : 'runs need'} you`}
                      >
                        <Hand size={11} aria-hidden="true" />
                        {summary.attention}
                        <span className="sr-only">
                          {summary.attention === 1 ? 'run needs you' : 'runs need you'}
                        </span>
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center gap-2 pl-[21px] text-xs text-text-tertiary">
                    <span className="min-w-0 truncate font-mono">
                      {factory.accessPending ? 'Access pending' : source}
                    </span>
                    {summary?.live ? (
                      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
                        <LiveGlyph small />
                        {summary.live} running
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {loaded && factories.length === 0 && !creating && (
          <p className="px-3 py-4 text-xs leading-5 text-text-tertiary">
            No factories in this workspace yet.
          </p>
        )}
        {pendingDirectory.length > 0 && (
          <div className="mt-4 border-t border-border-subtle pt-3">
            <h2 className="px-3 text-xs font-medium text-text-tertiary">Shared with you</h2>
            <ul className="mt-2 space-y-2">
              {pendingDirectory.map((item) => {
                const organizationId = item.policy.organizationId;
                return (
                  <li key={`pending-${item.id}`} className="rounded-lg px-3 py-2">
                    <p className="flex items-center gap-2 text-sm text-text-secondary">
                      <Lock size={13} aria-hidden="true" className="shrink-0 text-warning" />
                      Shared factory
                    </p>
                    <p className="mt-1 text-xs leading-5 text-text-tertiary">
                      {item.accessRequired
                        ? 'An organization owner must grant this account factory access.'
                        : item.accessPending
                          ? 'Enrol an encryption key to read this factory.'
                          : 'Access is waiting for organization setup.'}
                    </p>
                    {item.accessPending && !item.accessRequired && organizationId && (
                      <Button
                        className="mt-2"
                        variant="secondary"
                        size="sm"
                        disabled={keyRegistrationBusy !== null}
                        onClick={() => onRegisterKey(organizationId)}
                      >
                        <KeyRound size={13} aria-hidden="true" />
                        {keyRegistrationBusy === organizationId
                          ? 'Enrolling…'
                          : 'Enrol encryption key'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </nav>
    </aside>
  );
}

function FactoryFloor({
  factory,
  runs,
  runsLoaded,
  runsLoadedAt,
  selectedRun,
  templates,
  tab,
  stationFilter,
  activationPreview,
  activating,
  busyAction,
  savingCopy,
  now,
  personas,
  workspaces,
  activeWorkspaceId,
  onTab,
  onStationFilter,
  onRefresh,
  onSelectRun,
  onRunAction,
  onEdit,
  onRepin,
  onPrepareActivation,
  onConfirmActivation,
  onCancelActivation,
  onFactoryAction,
  onOpenThread,
  onOpenWorkflowRun,
  onOpenTemplate,
  onSaveWorkflowCopy,
  onLinkTemplate,
}: {
  factory: FactoryDefinition;
  runs: FactoryRun[];
  runsLoaded: boolean;
  runsLoadedAt: number | null;
  selectedRun: FactoryRun | null;
  templates: WorkflowTemplate[];
  tab: 'runs' | 'definition';
  stationFilter: FactoryStationId | null;
  activationPreview: FactoryPreview | null;
  activating: boolean;
  busyAction: string | null;
  savingCopy: boolean;
  now: number;
  personas: Persona[];
  workspaces: Array<{ id: string; name: string }>;
  activeWorkspaceId: string;
  onTab: (tab: 'runs' | 'definition') => void;
  onStationFilter: (station: FactoryStationId | null) => void;
  onRefresh: () => void;
  onSelectRun: (run: FactoryRun) => void;
  onRunAction: (
    action: FactoryRunControlInput['action'],
    context?: TakeoverContext,
  ) => Promise<boolean>;
  onEdit: () => void;
  onRepin: () => void;
  onPrepareActivation: () => void;
  onConfirmActivation: () => void;
  onCancelActivation: () => void;
  onFactoryAction: (action: 'pause' | 'resume' | 'deactivate') => void;
  onOpenThread: (threadId: string, personaId?: string) => void;
  onOpenWorkflowRun: (runId: string) => void;
  onOpenTemplate: (templateId: string) => void;
  onSaveWorkflowCopy: () => void;
  onLinkTemplate: (templateId: string) => void;
}) {
  const loads = useMemo(() => stationLoads(runs), [runs]);
  const detailRef = useRef<HTMLDivElement>(null);
  if (factory.accessPending) {
    return (
      <div className="space-y-4 px-6 py-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-text-primary">Shared factory</h2>
          <FactoryStatus status="pending" />
        </div>
        <Notice tone="warning" icon={Lock}>
          This shared record is encrypted for enrolled members. Your account has not completed key
          enrolment, so the factory’s details and runs stay hidden until it does.
        </Notice>
      </div>
    );
  }
  const isActive = factory.status === 'active';
  const hasUnactivatedRevision = factory.activeRevision !== factory.revision;
  const role = effectiveFactoryRole(factory);
  const canOperate = canOperateFactory(factory);
  const canManage = canManageFactory(factory);
  const sourceVisible = factory.sourceAccess !== false && !factory.redacted;
  const template = templates.find((item) => item.id === factory.definition.workflowTemplateId);
  // Template ids of shared factories belong to the executing device, so drift is local-only.
  const drift =
    !factory.remote && canReadFactorySource(factory)
      ? factoryWorkflowDrift(factory.workflow, template)
      : 'current';
  const activateLabel =
    factory.status === 'draft' || !factory.activeRevision
      ? 'Review and activate'
      : `Activate revision ${factory.revision}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border-subtle px-6 pt-4 pb-3">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-80">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="truncate text-lg font-semibold text-text-primary">
                {factory.definition.name}
              </h2>
              <FactoryStatus status={factoryStatusKey(factory)} />
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-tertiary">
              {sourceVisible ? (
                <>
                  <Mono className="text-text-secondary">
                    {factory.definition.github.owner}/{factory.definition.github.repo}
                  </Mono>
                  <span>
                    issues labelled <Mono>{factory.definition.github.label}</Mono>
                  </span>
                  <span>
                    into <Mono>{factory.definition.github.baseBranch}</Mono>
                  </span>
                </>
              ) : (
                <span>Source repository details are unavailable for your account.</span>
              )}
              {role && (
                <span>
                  Your role <span className="capitalize text-text-secondary">{role}</span>
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage &&
              !activationPreview &&
              (!isActive || hasUnactivatedRevision) &&
              factory.status !== 'paused' && (
                <Button size="sm" disabled={activating} onClick={onPrepareActivation}>
                  <Play size={13} aria-hidden="true" />
                  {activating ? 'Reviewing…' : activateLabel}
                </Button>
              )}
            {canOperate && isActive && !hasUnactivatedRevision && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => onFactoryAction('pause')}
              >
                <Pause size={13} aria-hidden="true" />
                Pause factory
              </Button>
            )}
            {canOperate && factory.status === 'paused' && !hasUnactivatedRevision && (
              <Button
                size="sm"
                disabled={busyAction !== null}
                onClick={() => onFactoryAction('resume')}
              >
                <Play size={13} aria-hidden="true" />
                Resume factory
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" size="sm" onClick={onEdit}>
                Edit
              </Button>
            )}
            {canManage && factory.status !== 'inactive' && (
              <Menu
                label="Factory actions"
                trigger={(props) => (
                  <IconButton
                    {...props}
                    icon={MoreHorizontal}
                    label="More factory actions"
                    size="md"
                  />
                )}
              >
                <MenuItem destructive onSelect={() => onFactoryAction('deactivate')}>
                  Deactivate factory
                </MenuItem>
              </Menu>
            )}
          </div>
        </div>
        <div className="mt-3 space-y-2 empty:hidden">
          {hasUnactivatedRevision && factory.activeRevision && (
            <Notice tone="info" icon={CircleAlert}>
              Revision {factory.revision} is saved but not active. Revision {factory.activeRevision}{' '}
              keeps processing issues until you activate it.
            </Notice>
          )}
          {factory.commandPending && (
            <Notice tone="warning" icon={RefreshCw}>
              Your request was accepted and is waiting for the factory owner’s device to apply it.
              The status shown may lag until then.
            </Notice>
          )}
          {factory.redacted && (
            <Notice tone="neutral" icon={Lock}>
              Some source details are hidden because you do not have permission to read them.
            </Notice>
          )}
          {factory.organizationAdmin && (
            <p className="text-xs text-text-tertiary">
              Organization administrator authority verified by the service.
            </p>
          )}
        </div>
      </header>

      {activationPreview ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            <FactoryAuthority
              preview={activationPreview}
              workflow={factory.workflow}
              mode="activate"
              revision={factory.revision}
              localExecutor={!factory.remote}
            >
              <Button variant="ghost" onClick={onCancelActivation}>
                Cancel
              </Button>
              <Button disabled={activating} onClick={onConfirmActivation}>
                <Play size={14} aria-hidden="true" />
                {activating ? 'Activating…' : `Activate revision ${factory.revision}`}
              </Button>
            </FactoryAuthority>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle px-6 py-2">
            <SegmentedControl
              label="Factory view"
              value={tab}
              onChange={onTab}
              options={[
                { value: 'runs', label: `Runs ${runs.length ? runs.length : ''}`.trim() },
                {
                  value: 'definition',
                  label: (
                    <>
                      Definition
                      {drift !== 'current' && (
                        <span
                          aria-hidden="true"
                          className={cx(
                            'h-1.5 w-1.5 rounded-full',
                            drift === 'missing' ? 'bg-warning' : 'bg-info',
                          )}
                        />
                      )}
                    </>
                  ),
                  ariaLabel:
                    drift === 'current'
                      ? 'Definition'
                      : drift === 'missing'
                        ? 'Definition: pinned workflow source deleted'
                        : 'Definition: pinned workflow changed',
                },
              ]}
            />
            <span className="ml-auto flex items-center gap-1.5 text-xs text-text-tertiary">
              {runsLoadedAt && (
                <span>Updated {relativeTime(new Date(runsLoadedAt).toISOString(), now)}</span>
              )}
              <IconButton icon={RefreshCw} label="Refresh runs" onClick={onRefresh} />
            </span>
          </div>
          {tab === 'definition' ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FactoryDefinitionPanel
                factory={factory}
                templates={templates}
                canManage={canManage}
                now={now}
                savingCopy={savingCopy}
                onEdit={onEdit}
                onRepin={onRepin}
                onOpenTemplate={onOpenTemplate}
                onSaveCopy={onSaveWorkflowCopy}
                onLinkTemplate={onLinkTemplate}
              />
            </div>
          ) : (
            <div className="factory-floor flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="shrink-0 border-b border-border-subtle px-4 py-2">
                <StationBoard loads={loads} selected={stationFilter} onSelect={onStationFilter} />
              </div>
              {runsLoaded && runs.length === 0 ? (
                <EmptyRuns
                  factory={factory}
                  canManage={canManage}
                  activating={activating}
                  onActivate={onPrepareActivation}
                />
              ) : (
                <div className="factory-split">
                  <RunList
                    factory={factory}
                    runs={runs}
                    loaded={runsLoaded}
                    selectedId={selectedRun?.id ?? null}
                    stationFilter={stationFilter}
                    now={now}
                    onClearFilter={() => onStationFilter(null)}
                    onSelect={(run) => {
                      onSelectRun(run);
                      // Single-column panes put the detail below the list; bring it into view.
                      const detail = detailRef.current;
                      if (detail && detail.offsetLeft === 0 && detail.offsetTop > 0)
                        requestAnimationFrame(() =>
                          detail.scrollIntoView({ block: 'start', behavior: 'smooth' }),
                        );
                    }}
                  />
                  <div ref={detailRef} className="min-w-0 scroll-mt-2">
                    {selectedRun ? (
                      <FactoryRunDetail
                        run={selectedRun}
                        canOperate={canOperate}
                        busyAction={busyAction}
                        now={now}
                        personas={personas}
                        workspaces={workspaces}
                        activeWorkspaceId={activeWorkspaceId}
                        onAction={onRunAction}
                        onOpenThread={onOpenThread}
                        onOpenWorkflowRun={onOpenWorkflowRun}
                      />
                    ) : (
                      runsLoaded &&
                      runs.length > 0 && (
                        <p className="px-6 py-10 text-sm text-text-tertiary">
                          Select a run to see where it is and what it needs.
                        </p>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RunList({
  factory,
  runs,
  loaded,
  selectedId,
  stationFilter,
  now,
  onClearFilter,
  onSelect,
}: {
  factory: FactoryDefinition;
  runs: FactoryRun[];
  loaded: boolean;
  selectedId: string | null;
  stationFilter: FactoryStationId | null;
  now: number;
  onClearFilter: () => void;
  onSelect: (run: FactoryRun) => void;
}) {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const visible = useMemo(
    () => (stationFilter ? runs.filter((run) => runPosition(run).station === stationFilter) : runs),
    [runs, stationFilter],
  );
  const groups = useMemo(() => groupRuns(visible), [visible]);
  const ordered = [...groups.attention, ...groups.active, ...groups.finished];
  const focusIndex = Math.max(
    0,
    ordered.findIndex((run) => run.id === selectedId),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowDown: focusIndex + 1,
      ArrowUp: focusIndex - 1,
      j: focusIndex + 1,
      k: focusIndex - 1,
      Home: 0,
      End: ordered.length - 1,
    };
    if (!(event.key in keys) || !ordered.length) return;
    event.preventDefault();
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, keys[event.key]))];
    onSelect(next);
    optionRefs.current.get(next.id)?.focus();
  };

  if (!loaded)
    return (
      <div className="space-y-2 p-4" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div
            key={item}
            className="h-14 animate-pulse rounded-lg bg-bg-tertiary/50 motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  if (!runs.length)
    return (
      <div className="px-5 py-8">
        <p className="text-sm font-medium text-text-primary">No issues on the line yet</p>
        <p className="mt-1 max-w-prose text-xs leading-5 text-text-tertiary">
          {factory.status === 'active' ? (
            <>
              Label an open issue <Mono>{factory.definition.github.label}</Mono> in{' '}
              <Mono>
                {factory.definition.github.owner}/{factory.definition.github.repo}
              </Mono>{' '}
              and it appears here within a minute.
            </>
          ) : (
            'Activate the factory to start claiming matching issues.'
          )}
        </p>
      </div>
    );

  return (
    <div className="py-2">
      {stationFilter && (
        <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2 text-xs text-text-tertiary">
          <span>
            At <span className="text-text-secondary">{stationOf(stationFilter).label}</span>
          </span>
          <button
            type="button"
            className="underline decoration-border underline-offset-4 hover:text-text-primary"
            onClick={onClearFilter}
          >
            Show all runs
          </button>
        </div>
      )}
      {!ordered.length && (
        <p className="px-4 py-6 text-xs text-text-tertiary">
          No runs at {stationFilter ? stationOf(stationFilter).label : 'this station'} right now.
        </p>
      )}
      <div
        role="listbox"
        aria-label="Issue runs"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className={ordered.length ? undefined : 'hidden'}
      >
        {(Object.keys(GROUP_LABELS) as RunGroup[]).map((group) =>
          groups[group].length ? (
            <div
              key={group}
              role="group"
              aria-label={`${GROUP_LABELS[group]}, ${groups[group].length}`}
              className="mb-2"
            >
              <div
                aria-hidden="true"
                className={cx(
                  'flex items-center gap-2 px-4 pt-2 pb-1.5 text-xs font-medium',
                  group === 'attention' ? 'text-warning' : 'text-text-tertiary',
                )}
              >
                {GROUP_LABELS[group]}
                <span className="tabular-nums text-text-muted">{groups[group].length}</span>
              </div>
              <div className="space-y-0.5 px-2">
                {groups[group].map((run) => {
                  const position = runPosition(run);
                  const selected = run.id === selectedId;
                  const sourceAccess = canReadRunSource(run);
                  return (
                    <button
                      key={run.id}
                      ref={(element) => {
                        if (element) optionRefs.current.set(run.id, element);
                        else optionRefs.current.delete(run.id);
                      }}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      tabIndex={run.id === ordered[focusIndex]?.id ? 0 : -1}
                      onClick={() => onSelect(run)}
                      className={cx(
                        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                        selected
                          ? 'bg-accent/[0.08] ring-1 ring-accent/30 ring-inset'
                          : 'hover:bg-bg-tertiary',
                      )}
                    >
                      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center">
                        <RunStateIcon state={position.state} size={14} />
                        <span className="sr-only">{RUN_STATE_META[position.state].label}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          {sourceAccess && (
                            <span className="shrink-0 font-mono text-xs text-text-tertiary">
                              #{run.issue.number}
                            </span>
                          )}
                          <span
                            className={cx(
                              'truncate text-sm',
                              selected ? 'text-text-primary' : 'text-text-secondary',
                            )}
                          >
                            {sourceAccess ? run.issue.title : 'Issue source unavailable'}
                          </span>
                        </span>
                        <span className="mt-1.5 flex items-center gap-2.5 text-xs text-text-tertiary">
                          <RunTrack run={run} />
                          <span className="truncate">
                            {group === 'finished'
                              ? RUN_STATE_META[position.state].label
                              : stationOf(position.station).label}
                          </span>
                          <time className="ml-auto shrink-0" dateTime={run.updatedAt}>
                            {relativeTime(run.updatedAt, now)}
                          </time>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function EmptyRuns({
  factory,
  canManage,
  activating,
  onActivate,
}: {
  factory: FactoryDefinition;
  canManage: boolean;
  activating: boolean;
  onActivate: () => void;
}) {
  const { github, limits } = factory.definition;
  return (
    <div className="px-6 py-10">
      <div className="max-w-xl">
        <h3 className="text-sm font-semibold text-text-primary">No issues on the line yet</h3>
        <p className="mt-1.5 text-sm leading-6 text-text-secondary">
          {factory.status === 'active' ? (
            <>
              Label an open issue <Mono>{github.label}</Mono> in{' '}
              <Mono>
                {github.owner}/{github.repo}
              </Mono>
              . It appears here on the factory’s next check, and up to {limits.maxConcurrentRuns}{' '}
              run at once.
            </>
          ) : factory.status === 'paused' ? (
            'The factory is paused. Resume it to claim matching issues again.'
          ) : (
            <>
              Activating lets this factory claim open issues labelled <Mono>{github.label}</Mono>{' '}
              and publish pull requests under the policy you review first.
            </>
          )}
        </p>
        {canManage && (factory.status === 'draft' || factory.status === 'inactive') && (
          <Button className="mt-5" disabled={activating} onClick={onActivate}>
            <Play size={14} aria-hidden="true" />
            {activating ? 'Reviewing…' : 'Review and activate'}
          </Button>
        )}
      </div>
    </div>
  );
}

function EmptyFactories({ onStart }: { onStart: (request: string) => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-8 py-14">
        <h2 className="max-w-xl text-xl font-semibold leading-snug text-balance text-text-primary">
          Turn labelled issues into merged, verified pull requests
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-6 text-text-secondary">
          A factory watches one repository for a label and runs every matching issue down the same
          line. You decide what it must prove, whether it may publish, and who approves each merge.
        </p>
        <ol className="factory-line mt-10" aria-label="The factory line">
          {FACTORY_STATIONS.map((station) => (
            <li key={station.id} className="factory-line-station px-1">
              <span className="factory-line-marker" data-mark="idle" />
              <span className="factory-line-label">{station.label}</span>
              <span className="mt-1 hidden text-xs leading-5 text-text-tertiary @[640px]:block">
                {station.description}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-12 flex flex-wrap items-center gap-2">
          <Button onClick={() => onStart('')}>
            <Plus size={15} aria-hidden="true" />
            Describe a factory
          </Button>
          {DRAFT_EXAMPLES.map((example) => (
            <Button key={example.label} variant="ghost" onClick={() => onStart(example.request)}>
              {example.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
