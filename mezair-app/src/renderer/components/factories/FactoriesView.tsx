import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Factory,
  GitPullRequest,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  FactoryAccess,
  FactoryDefinition,
  FactoryDefinitionInput,
  FactoryDirectoryItem,
  FactoryOrganizationMember,
  FactoryOrganizationOption,
  FactoryPreview,
  FactoryRole,
  FactoryRun,
  FactoryRunControlInput,
} from '../../../shared/factories';
import type {
  Persona,
  RepoInfo,
  WorkflowTemplate,
  WorkspaceWithRepos,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import {
  canManageFactory,
  canOperateFactory,
  canReadRunSource,
  effectiveFactoryRole,
} from './factory-ui-policy';
import { recipientPickupThread, takeoverControlInput } from './factory-pickup';

const DEFAULT_LIMITS = {
  repairRounds: 2,
  maxRunMinutes: 90,
  maxCommands: 40,
  maxConcurrentRuns: 2,
};

const STAGE_LABELS: Record<FactoryRun['stage'], string> = {
  received: 'Received',
  implementing: 'Implementing',
  validating: 'Validating',
  publishing: 'Publishing',
  'waiting-checks': 'Waiting for checks',
  repairing: 'Repairing',
  'awaiting-merge-approval': 'Awaiting merge approval',
  merging: 'Merging',
  'verifying-merge': 'Verifying merge',
  cancelling: 'Cancellation pending',
  completed: 'Completed',
  blocked: 'Blocked',
  paused: 'Paused',
  cancelled: 'Cancelled',
  'taken-over': 'Picked up',
};

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function githubIdentity(repo: RepoInfo): FactoryDefinitionInput['github'] {
  const remote = repo.remoteUrl ?? '';
  const match =
    remote.match(/^(?:https?:\/\/|ssh:\/\/git@)([^/:]+)[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i) ??
    remote.match(/^git@([^:]+):([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  return {
    host: match?.[1] ?? 'github.com',
    owner: match?.[2] ?? '',
    repo: match?.[3] ?? repo.name,
    label: 'ready-for-agent',
    baseBranch: repo.defaultBranch || 'main',
  };
}

function newDefinition(workspaceId: string, repo?: RepoInfo): FactoryDefinitionInput {
  const github = repo
    ? githubIdentity(repo)
    : {
        host: 'github.com',
        owner: '',
        repo: '',
        label: 'ready-for-agent',
        baseBranch: 'main',
      };
  return {
    name: 'Issue to reviewed PR',
    workspaceId,
    repoId: repo?.id ?? '',
    github,
    workflowTemplateId: '',
    criteria: ['The configured pre-PR check command exits successfully.'],
    checks: ['pnpm test'],
    postMergeChecks: ['pnpm test'],
    limits: { ...DEFAULT_LIMITS },
    publication: { enabled: true, draft: true },
    merge: {
      mode: 'human-approved',
      method: 'squash',
      requiredChecks: [],
      requireApproval: true,
    },
    access: { kind: 'private' },
  };
}

function withAccess(current: FactoryAccess, kind: 'private' | 'organization'): FactoryAccess {
  if (kind === 'private') return { kind: 'private' };
  if (current.kind === 'organization') return current;
  return {
    kind: 'organization',
    organizationId: '',
    visibility: 'team',
    teamId: '',
    members: [],
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 text-sm text-text-primary">
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs leading-relaxed text-text-tertiary">{hint}</span>
      )}
    </label>
  );
}

function inputClass(disabled = false): string {
  return `mt-1.5 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent ${disabled ? 'opacity-60' : ''}`;
}

export function FactoriesView() {
  const { activeWorkspace, repos, workspaces } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [factories, setFactories] = useState<FactoryDefinition[]>([]);
  const [organizations, setOrganizations] = useState<FactoryOrganizationOption[]>([]);
  const [directory, setDirectory] = useState<FactoryDirectoryItem[]>([]);
  const [organizationMembers, setOrganizationMembers] = useState<FactoryOrganizationMember[]>([]);
  const [keyRegistrationBusy, setKeyRegistrationBusy] = useState<string | null>(null);
  const [runs, setRuns] = useState<FactoryRun[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedFactoryId, setSelectedFactoryId] = useState<string | null>(
    searchParams.get('factory'),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(searchParams.get('run'));
  const [runsFactoryId, setRunsFactoryId] = useState<string | null>(null);
  const [editingFactoryId, setEditingFactoryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FactoryDefinitionInput | null>(null);
  const [preview, setPreview] = useState<FactoryPreview | null>(null);
  const [request, setRequest] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteUserId, setInviteUserId] = useState('');
  const [inviteRole, setInviteRole] = useState<FactoryRole>('viewer');
  const [activationPreview, setActivationPreview] = useState<FactoryPreview | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [pickupRunId, setPickupRunId] = useState<string | null>(null);
  const [pickupWorkspaceId, setPickupWorkspaceId] = useState(activeWorkspace?.id ?? '');
  const [pickupWorkspace, setPickupWorkspace] = useState<WorkspaceWithRepos | null>(
    activeWorkspace,
  );
  const [pickupPersonaId, setPickupPersonaId] = useState('coder');
  const [pickupRepoId, setPickupRepoId] = useState('');
  const [pickupWorkspaceLoading, setPickupWorkspaceLoading] = useState(false);
  const pickupWorkspaceGeneration = useRef(0);
  const selectedFactoryRef = useRef(selectedFactoryId);
  const selectedRunRef = useRef(selectedRunId);
  const draftOpenRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const runGenerationRef = useRef(0);
  const workspaceIdRef = useRef(activeWorkspace?.id);
  const previousWorkspaceIdRef = useRef(activeWorkspace?.id);
  workspaceIdRef.current = activeWorkspace?.id;

  const selectedFactory = factories.find((item) => item.id === selectedFactoryId) ?? null;
  const selectedRun =
    runsFactoryId === selectedFactoryId
      ? (runs.find((item) => item.id === selectedRunId) ?? null)
      : null;
  const githubRepos = useMemo(
    () => repos.filter((repo) => /github\.com|github/i.test(repo.remoteUrl ?? '')),
    [repos],
  );
  const matchingPickupRepos = useMemo(() => {
    const source = selectedRun?.snapshot.definition.github ?? selectedFactory?.definition.github;
    if (!source || !pickupWorkspace) return [];
    return pickupWorkspace.repos.filter((repo) => {
      const local = githubIdentity(repo);
      return (
        local.host.toLowerCase() === source.host.toLowerCase() &&
        local.owner.toLowerCase() === source.owner.toLowerCase() &&
        local.repo.toLowerCase() === source.repo.toLowerCase()
      );
    });
  }, [pickupWorkspace, selectedFactory, selectedRun]);

  useEffect(() => {
    window.mezair.chat
      .getPersonas()
      .then((items) => {
        setPersonas(items);
        setPickupPersonaId((current) =>
          items.some((persona) => persona.id === current) ? current : (items[0]?.id ?? 'coder'),
        );
      })
      .catch(() => setPersonas([]));
  }, []);

  useEffect(() => {
    const organizationId = draft?.access.kind === 'organization' ? draft.access.organizationId : '';
    if (!organizationId) {
      setOrganizationMembers([]);
      return;
    }
    let current = true;
    window.mezair.factories
      .listOrganizationMembers(organizationId)
      .then((items) => {
        if (current) setOrganizationMembers(items);
      })
      .catch(() => {
        if (current) setOrganizationMembers([]);
      });
    return () => {
      current = false;
    };
  }, [draft?.access.kind === 'organization' ? draft.access.organizationId : '']);

  useEffect(() => {
    if (!pickupWorkspaceId) {
      setPickupWorkspace(null);
      setPickupRepoId('');
      return;
    }
    const generation = ++pickupWorkspaceGeneration.current;
    setPickupWorkspaceLoading(true);
    window.mezair.workspace
      .get(pickupWorkspaceId)
      .then((workspace) => {
        if (generation !== pickupWorkspaceGeneration.current) return;
        setPickupWorkspace(workspace);
        setPickupRepoId('');
      })
      .catch((cause) => {
        if (generation !== pickupWorkspaceGeneration.current) return;
        setPickupWorkspace(null);
        setPickupRepoId('');
        setError(
          cause instanceof Error ? cause.message : 'Could not load the selected pickup workspace.',
        );
      })
      .finally(() => {
        if (generation === pickupWorkspaceGeneration.current) setPickupWorkspaceLoading(false);
      });
    return () => {
      pickupWorkspaceGeneration.current += 1;
    };
  }, [pickupWorkspaceId]);

  const loadRuns = useCallback(async (factoryId: string) => {
    const generation = ++runGenerationRef.current;
    setRuns([]);
    setRunsFactoryId(factoryId);
    try {
      const nextRuns = await window.mezair.factories.listRuns(factoryId);
      if (generation !== runGenerationRef.current || selectedFactoryRef.current !== factoryId)
        return;
      setRuns(nextRuns);
      const runId = selectedRunRef.current;
      if (!runId || !nextRuns.some((item) => item.id === runId)) {
        const firstRunId = nextRuns[0]?.id ?? null;
        selectedRunRef.current = firstRunId;
        setSelectedRunId(firstRunId);
      }
    } catch (cause) {
      if (generation !== runGenerationRef.current || selectedFactoryRef.current !== factoryId)
        return;
      setRuns([]);
      setRunsFactoryId(null);
      selectedRunRef.current = null;
      setSelectedRunId(null);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Run access changed. Reload after permissions are restored.',
      );
    }
  }, []);

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
      if (draftOpenRef.current) return;
      const requestedId = searchParams.get('factory');
      const currentId = selectedFactoryRef.current;
      const targetId = items.some((item) => item.id === requestedId)
        ? requestedId
        : items.some((item) => item.id === currentId)
          ? currentId
          : (items[0]?.id ?? null);
      selectedFactoryRef.current = targetId;
      setSelectedFactoryId(targetId);
      if (!targetId) {
        setRuns([]);
        setRunsFactoryId(null);
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
    }
  }, [activeWorkspace?.id, loadRuns, searchParams]);

  const registerOrganizationKey = async (organizationId: string) => {
    setKeyRegistrationBusy(organizationId);
    setError(null);
    setNotice(null);
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

  useEffect(() => {
    setError(null);
    if (previousWorkspaceIdRef.current !== activeWorkspace?.id) {
      // A draft belongs to the workspace in which it was composed. Never let a
      // late response or an open editor bleed into another workspace.
      previousWorkspaceIdRef.current = activeWorkspace?.id;
      draftOpenRef.current = false;
      setDraft(null);
      setPreview(null);
      setActivationPreview(null);
      setEditingFactoryId(null);
      selectedFactoryRef.current = null;
      selectedRunRef.current = null;
    }
    reload().catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Could not load software factories.'),
    );
  }, [activeWorkspace?.id, reload]);

  useEffect(() => {
    if (!selectedFactoryId || !activeWorkspace?.id) return;
    const timer = window.setInterval(() => {
      void loadRuns(selectedFactoryId);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [selectedFactoryId, activeWorkspace?.id, loadRuns]);

  useEffect(() => {
    const selectedId = searchParams.get('factory');
    if (selectedId && selectedId !== selectedFactoryId) {
      draftOpenRef.current = false;
      setDraft(null);
      setEditingFactoryId(null);
      selectedFactoryRef.current = selectedId;
      setSelectedFactoryId(selectedId);
      void loadRuns(selectedId);
    }
    const runId = searchParams.get('run');
    if (runId && runId !== selectedRunId) {
      selectedRunRef.current = runId;
      setSelectedRunId(runId);
    }
  }, [searchParams, selectedFactoryId, selectedRunId, loadRuns]);

  const setDefinition = (update: (current: FactoryDefinitionInput) => FactoryDefinitionInput) => {
    setDraft((current) => (current ? update(current) : current));
    setPreview(null);
    setActivationPreview(null);
    setError(null);
    setNotice(null);
  };

  const chooseFactory = (factory: FactoryDefinition) => {
    draftOpenRef.current = false;
    selectedFactoryRef.current = factory.id;
    selectedRunRef.current = null;
    setSelectedFactoryId(factory.id);
    setSelectedRunId(null);
    setEditingFactoryId(null);
    setDraft(null);
    setPreview(null);
    setActivationPreview(null);
    setSearchParams({ factory: factory.id }, { replace: true });
    void loadRuns(factory.id);
  };

  const startNew = () => {
    if (!activeWorkspace?.id) return;
    const value = newDefinition(activeWorkspace.id, githubRepos[0] ?? repos[0]);
    draftOpenRef.current = true;
    selectedFactoryRef.current = null;
    selectedRunRef.current = null;
    setSelectedFactoryId(null);
    setSelectedRunId(null);
    setEditingFactoryId(null);
    setDraft(value);
    setPreview(null);
    setActivationPreview(null);
    setRuns([]);
    setSearchParams({}, { replace: true });
    setNotice(null);
    setError(null);
  };

  const startConversationalDraft = async () => {
    if (!activeWorkspace?.id || !request.trim()) return;
    const workspaceId = activeWorkspace.id;
    setDraftBusy(true);
    draftOpenRef.current = true;
    setEditingFactoryId(null);
    selectedFactoryRef.current = null;
    setError(null);
    setNotice(null);
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
      setSelectedFactoryId(null);
      setSelectedRunId(null);
      setEditingFactoryId(null);
      setRuns([]);
      const nextPreview = await window.mezair.factories.preview(proposed);
      if (workspaceIdRef.current === workspaceId) setPreview(nextPreview);
      setSearchParams({}, { replace: true });
    } catch (cause) {
      if (workspaceIdRef.current !== workspaceId) return;
      draftOpenRef.current = false;
      setError(cause instanceof Error ? cause.message : 'Could not draft a factory.');
    } finally {
      setDraftBusy(false);
    }
  };

  const updateRepo = (repoId: string) => {
    const repo = repos.find((item) => item.id === repoId);
    if (!repo) return;
    setDefinition((current) => ({ ...current, repoId, github: githubIdentity(repo) }));
  };

  const makePreview = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (draft.access.kind === 'organization' && draft.access.visibility === 'team') {
        if (!draft.access.teamId?.trim())
          throw new Error('Choose a GitHub team slug for team visibility.');
        const valid = await window.mezair.factories.validateOrganizationTeam(
          draft.access.organizationId,
          { host: 'github.com', owner: draft.github.owner, repo: draft.github.repo },
          draft.access.teamId.trim(),
        );
        if (!valid)
          throw new Error('The selected GitHub team is not authorized for this repository.');
      }
      setPreview(await window.mezair.factories.preview(draft, editingFactoryId ?? undefined));
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
    setError(null);
    setNotice(null);
    try {
      const saved = await window.mezair.factories.save({
        definition: preview.definition,
        confirmation: preview.confirmation,
        ...(editingFactoryId && selectedFactory
          ? { id: editingFactoryId, expectedRevision: selectedFactory.revision }
          : {}),
      });
      draftOpenRef.current = false;
      selectedFactoryRef.current = saved.id;
      selectedRunRef.current = null;
      setFactories((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setSelectedFactoryId(saved.id);
      setEditingFactoryId(null);
      setDraft(null);
      setPreview(null);
      setSearchParams({ factory: saved.id }, { replace: true });
      void loadRuns(saved.id);
      setNotice('Draft saved. It will not process issues until you activate it.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Factory draft could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const prepareActivation = async () => {
    if (!selectedFactory) return;
    setActivating(true);
    setError(null);
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
    setError(null);
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
      setNotice('Factory activated. Matching issues will be processed under this reviewed policy.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not activate factory.');
    } finally {
      setActivating(false);
    }
  };

  const doFactoryAction = async (action: 'pause' | 'resume' | 'deactivate') => {
    if (!selectedFactory) return;
    setBusyAction(action);
    setError(null);
    setNotice(null);
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
    }
  };

  const doRunAction = async (action: FactoryRunControlInput['action']) => {
    if (!selectedRun) return;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const controlInput =
        action === 'takeover' && pickupWorkspaceId && pickupPersonaId
          ? takeoverControlInput(selectedRun.id, {
              workspaceId: pickupWorkspaceId,
              ...(pickupRepoId ? { repoId: pickupRepoId } : {}),
              personaId: pickupPersonaId,
            })
          : { runId: selectedRun.id, action };
      const updated = await window.mezair.factories.controlRun({
        ...controlInput,
        ...(action === 'approve-merge' && selectedRun.observation?.headSha
          ? { expectedHeadSha: selectedRun.observation.headSha }
          : {}),
        ...(action === 'takeover' && pickupWorkspaceId && pickupPersonaId
          ? {
              takeoverContext: {
                workspaceId: pickupWorkspaceId,
                ...(pickupRepoId ? { repoId: pickupRepoId } : {}),
                personaId: pickupPersonaId,
              },
            }
          : {}),
      });
      setRuns((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      selectedRunRef.current = updated.id;
      setSelectedRunId(updated.id);
      const pickupThreadId = action === 'takeover' ? recipientPickupThread(updated) : null;
      if (pickupThreadId) {
        navigate(
          `/chat?thread=${encodeURIComponent(pickupThreadId)}&persona=${encodeURIComponent(pickupPersonaId)}`,
        );
        setPickupRunId(null);
      } else if (action === 'takeover') {
        setNotice(
          'Run was claimed for pickup, but no private chat link was returned. Refresh the run.',
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} issue run.`);
    } finally {
      setBusyAction(null);
    }
  };

  const addMember = () => {
    if (!draft || draft.access.kind !== 'organization' || !inviteUserId.trim()) return;
    const next = draft.access.members.filter((member) => member.userId !== inviteUserId.trim());
    next.push({ userId: inviteUserId.trim(), role: inviteRole });
    setDefinition((current) => ({
      ...current,
      access:
        current.access.kind === 'organization'
          ? { ...current.access, members: next }
          : current.access,
    }));
    setInviteUserId('');
  };

  const removeMember = (userId: string) => {
    setDefinition((current) => ({
      ...current,
      access:
        current.access.kind === 'organization'
          ? {
              ...current.access,
              members: current.access.members.filter((member) => member.userId !== userId),
            }
          : current.access,
    }));
  };

  if (!activeWorkspace) {
    return (
      <div className="p-8 text-sm text-text-secondary">Choose a workspace to manage factories.</div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
            <Factory size={20} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Software factories</h1>
            <p className="text-xs text-text-secondary">Issue intake through verified merge</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void reload()}>
            <RefreshCw size={14} /> Refresh
          </Button>
          <Button size="sm" onClick={startNew}>
            <Plus size={15} /> New factory
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary/50">
          <div className="border-b border-border-subtle p-3">
            <label className="sr-only" htmlFor="factory-request">
              Describe a factory
            </label>
            <textarea
              id="factory-request"
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Describe the issue-to-PR process you want…"
              rows={3}
              className="w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent"
            />
            <Button
              className="mt-2 w-full"
              size="sm"
              disabled={draftBusy || !request.trim()}
              onClick={() => void startConversationalDraft()}
            >
              <Sparkles size={14} /> {draftBusy ? 'Drafting…' : 'Draft from chat'}
            </Button>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Factories
            </span>
            <span className="text-xs text-text-tertiary">{factories.length}</span>
          </div>
          {directory
            .filter((item) => item.accessPending || item.accessRequired)
            .map((item) => {
              const organizationId = item.policy.organizationId;
              return (
                <div
                  key={`pending-${item.id}`}
                  className="mx-2 mb-2 rounded-lg border border-warning/30 bg-warning/5 p-3"
                >
                  <p className="text-xs font-medium text-text-primary">
                    Shared factory access needs setup
                  </p>
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    {item.accessRequired
                      ? 'An organization owner must grant this account factory access.'
                      : item.accessPending
                        ? 'Encrypted factory content is not available to this account yet.'
                        : 'Access is waiting for organization setup.'}
                  </p>
                  {item.accessPending && !item.accessRequired && organizationId && (
                    <Button
                      className="mt-2"
                      variant="secondary"
                      size="sm"
                      disabled={keyRegistrationBusy !== null}
                      onClick={() => void registerOrganizationKey(organizationId)}
                    >
                      {keyRegistrationBusy === organizationId
                        ? 'Enrolling…'
                        : 'Enroll encryption key'}
                    </Button>
                  )}
                </div>
              );
            })}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {factories.length === 0 ? (
              <p className="px-3 py-5 text-xs leading-relaxed text-text-tertiary">
                No saved factories yet. Draft one from a request above or create a blank definition.
              </p>
            ) : (
              factories.map((factory) => (
                <button
                  key={factory.id}
                  type="button"
                  onClick={() => chooseFactory(factory)}
                  className={`mb-1 w-full rounded-lg px-3 py-3 text-left ${
                    selectedFactoryId === factory.id
                      ? 'bg-accent/10 text-text-primary ring-1 ring-accent/30'
                      : 'text-text-secondary hover:bg-bg-tertiary'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {factory.accessPending
                        ? 'Shared factory access pending'
                        : factory.definition.name}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${factory.status === 'active' ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-tertiary'}`}
                    >
                      {factory.accessPending ? 'pending' : factory.status}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                    {!factory.accessPending && (
                      <>
                        <span>r{factory.revision}</span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">
                          {factory.sourceAccess === true
                            ? `${factory.definition.github.owner}/${factory.definition.github.repo}`
                            : 'Source details pending'}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {(error || notice) && (
            <div
              className={`mx-6 mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${error ? 'border-error/30 bg-error/5 text-error' : 'border-success/30 bg-success/5 text-success'}`}
              role={error ? 'alert' : 'status'}
            >
              {error ? (
                <CircleAlert size={16} className="mt-0.5 shrink-0" />
              ) : (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              )}
              <span>{error ?? notice}</span>
            </div>
          )}

          {draft ? (
            <FactoryEditor
              draft={draft}
              templates={templates}
              repos={githubRepos.length ? githubRepos : repos}
              organizations={organizations}
              organizationMembers={organizationMembers}
              preview={preview}
              busy={saving}
              inviteUserId={inviteUserId}
              inviteRole={inviteRole}
              onInviteUserId={setInviteUserId}
              onInviteRole={setInviteRole}
              onDefinition={setDefinition}
              onRepo={updateRepo}
              onAddMember={addMember}
              onRemoveMember={removeMember}
              onMemberRole={(userId, role) =>
                setDefinition((current) => ({
                  ...current,
                  access:
                    current.access.kind === 'organization'
                      ? {
                          ...current.access,
                          members: current.access.members.map((member) =>
                            member.userId === userId ? { ...member, role } : member,
                          ),
                        }
                      : current.access,
                }))
              }
              onPreview={() => void makePreview()}
              onSave={() => void saveDraft()}
              onCancel={() => {
                draftOpenRef.current = false;
                setEditingFactoryId(null);
                setDraft(null);
                setPreview(null);
                setActivationPreview(null);
                void reload();
              }}
              editing={Boolean(selectedFactory)}
              editingRemote={selectedFactory?.remote === true}
            />
          ) : selectedFactory ? (
            <FactoryDetails
              factory={selectedFactory}
              runs={runs}
              selectedRun={selectedRun}
              activationPreview={activationPreview}
              activating={activating}
              busyAction={busyAction}
              onEdit={() => {
                draftOpenRef.current = true;
                setEditingFactoryId(selectedFactory.id);
                setDraft(structuredClone(selectedFactory.definition));
                setPreview(null);
                setActivationPreview(null);
              }}
              onPrepareActivation={() => void prepareActivation()}
              onConfirmActivation={() => void confirmActivation()}
              onCancelActivation={() => setActivationPreview(null)}
              onFactoryAction={(action) => void doFactoryAction(action)}
              onSelectRun={(run) => {
                selectedRunRef.current = run.id;
                setSelectedRunId(run.id);
                setSearchParams({ factory: selectedFactory.id, run: run.id }, { replace: true });
              }}
              onRunAction={(action) => void doRunAction(action)}
              onOpenPickupThread={(threadId) =>
                navigate(`/chat?thread=${encodeURIComponent(threadId)}`)
              }
              pickupRunId={pickupRunId}
              pickupWorkspaceId={pickupWorkspaceId}
              pickupWorkspace={pickupWorkspace}
              pickupWorkspaceLoading={pickupWorkspaceLoading}
              pickupPersonaId={pickupPersonaId}
              pickupRepoId={pickupRepoId}
              workspaces={workspaces}
              personas={personas}
              matchingPickupRepos={matchingPickupRepos}
              onRequestPickup={(run) => {
                setPickupRunId(run.id);
                setPickupWorkspaceId(activeWorkspace?.id ?? '');
                setPickupRepoId('');
                setError(null);
              }}
              onPickupWorkspace={setPickupWorkspaceId}
              onPickupPersona={setPickupPersonaId}
              onPickupRepo={setPickupRepoId}
              onCancelPickup={() => setPickupRunId(null)}
            />
          ) : (
            <EmptyFactories onCreate={startNew} />
          )}
        </main>
      </div>
    </div>
  );
}

function FactoryEditor({
  draft,
  templates,
  repos,
  organizations,
  organizationMembers,
  preview,
  busy,
  inviteUserId,
  inviteRole,
  onInviteUserId,
  onInviteRole,
  onDefinition,
  onRepo,
  onAddMember,
  onRemoveMember,
  onMemberRole,
  onPreview,
  onSave,
  onCancel,
  editing,
  editingRemote,
}: {
  draft: FactoryDefinitionInput;
  templates: WorkflowTemplate[];
  repos: RepoInfo[];
  organizations: FactoryOrganizationOption[];
  organizationMembers: FactoryOrganizationMember[];
  preview: FactoryPreview | null;
  busy: boolean;
  inviteUserId: string;
  inviteRole: FactoryRole;
  onInviteUserId: (value: string) => void;
  onInviteRole: (value: FactoryRole) => void;
  onDefinition: (update: (current: FactoryDefinitionInput) => FactoryDefinitionInput) => void;
  onRepo: (repoId: string) => void;
  onAddMember: () => void;
  onRemoveMember: (userId: string) => void;
  onMemberRole: (userId: string, role: FactoryRole) => void;
  onPreview: () => void;
  onSave: () => void;
  onCancel: () => void;
  editing: boolean;
  editingRemote: boolean;
}) {
  const orgAccess = draft.access.kind === 'organization' ? draft.access : null;
  const criteriaChecksMatch =
    draft.criteria.length > 0 && draft.criteria.length === draft.checks.length;
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-accent">
            {editing ? 'Revise' : 'New'} definition
          </div>
          <h2 className="mt-1 text-xl font-semibold text-text-primary">
            Review the factory definition
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            This is an inactive draft. Preview the typed configuration before saving; activate it
            separately after reviewing its authority.
          </p>
        </div>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <section className="grid gap-4 rounded-xl border border-border-subtle bg-bg-secondary/40 p-4 md:grid-cols-2">
        <Field label="Factory name">
          <input
            className={inputClass()}
            value={draft.name}
            onChange={(event) =>
              onDefinition((current) => ({ ...current, name: event.target.value }))
            }
          />
        </Field>
        <Field
          label="Repository"
          hint={
            editingRemote
              ? 'The designated executor’s local repository identity is retained. Repository ownership cannot be changed in a shared revision.'
              : 'The first slice processes GitHub issues in one repository.'
          }
        >
          {editingRemote ? (
            <div className={`${inputClass(true)} cursor-not-allowed`}>
              {draft.github.owner}/{draft.github.repo}
            </div>
          ) : (
            <select
              className={inputClass()}
              value={draft.repoId}
              onChange={(event) => onRepo(event.target.value)}
            >
              <option value="">Select a GitHub repository</option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Issue label" hint="Only open issues carrying this label are eligible.">
          <input
            className={inputClass()}
            value={draft.github.label}
            onChange={(event) =>
              onDefinition((current) => ({
                ...current,
                github: { ...current.github, label: event.target.value },
              }))
            }
          />
        </Field>
        <Field label="Base branch">
          <input
            className={inputClass()}
            value={draft.github.baseBranch}
            onChange={(event) =>
              onDefinition((current) => ({
                ...current,
                github: { ...current.github, baseBranch: event.target.value },
              }))
            }
          />
        </Field>
        <Field
          label="Workflow graph"
          hint="Saved workflow graphs are pinned by the backend when this revision is saved."
        >
          <select
            className={inputClass()}
            value={draft.workflowTemplateId}
            onChange={(event) =>
              onDefinition((current) => ({ ...current, workflowTemplateId: event.target.value }))
            }
          >
            <option value="">Select a saved workflow</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Acceptance criteria"
          hint="One criterion per line; each requires evidence before publication."
        >
          <textarea
            className={`${inputClass()} min-h-24 resize-y`}
            value={draft.criteria.join('\n')}
            onChange={(event) =>
              onDefinition((current) => ({ ...current, criteria: splitLines(event.target.value) }))
            }
          />
        </Field>
        <Field
          label="Pre-PR checks"
          hint="One command per line, run in the selected repository scope."
        >
          <textarea
            className={`${inputClass()} min-h-24 resize-y font-mono text-xs`}
            value={draft.checks.join('\n')}
            onChange={(event) =>
              onDefinition((current) => ({ ...current, checks: splitLines(event.target.value) }))
            }
          />
        </Field>
        <Field
          label="Post-merge checks"
          hint="One command per line, run after the provider confirms the merge."
        >
          <textarea
            className={`${inputClass()} min-h-24 resize-y font-mono text-xs`}
            value={draft.postMergeChecks.join('\n')}
            onChange={(event) =>
              onDefinition((current) => ({
                ...current,
                postMergeChecks: splitLines(event.target.value),
              }))
            }
          />
        </Field>
      </section>
      <p
        className={`-mt-3 text-xs ${criteriaChecksMatch ? 'text-text-tertiary' : 'text-warning'}`}
        role={criteriaChecksMatch ? undefined : 'alert'}
      >
        Each acceptance criterion needs one exact standing-approved check command.{' '}
        {draft.criteria.length} criteria · {draft.checks.length} checks.
      </p>

      <section className="rounded-xl border border-border-subtle p-4">
        <h3 className="text-sm font-semibold text-text-primary">Limits and publication</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            label="Repair rounds"
            value={draft.limits.repairRounds}
            max={5}
            onChange={(value) =>
              onDefinition((current) => ({
                ...current,
                limits: { ...current.limits, repairRounds: value },
              }))
            }
          />
          <NumberField
            label="Run minutes"
            value={draft.limits.maxRunMinutes}
            max={1440}
            onChange={(value) =>
              onDefinition((current) => ({
                ...current,
                limits: { ...current.limits, maxRunMinutes: value },
              }))
            }
          />
          <NumberField
            label="Command budget"
            value={draft.limits.maxCommands}
            max={1000}
            onChange={(value) =>
              onDefinition((current) => ({
                ...current,
                limits: { ...current.limits, maxCommands: value },
              }))
            }
          />
          <NumberField
            label="Concurrent issues"
            value={draft.limits.maxConcurrentRuns}
            max={20}
            onChange={(value) =>
              onDefinition((current) => ({
                ...current,
                limits: { ...current.limits, maxConcurrentRuns: value },
              }))
            }
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2 text-text-primary">
            <input
              type="checkbox"
              checked={draft.publication.enabled}
              disabled={draft.merge.mode === 'auto-merge'}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  publication: { ...current.publication, enabled: event.target.checked },
                }))
              }
            />
            Allow branch and PR publication
          </label>
          <label className="flex items-center gap-2 text-text-primary">
            <input
              type="checkbox"
              checked={draft.publication.draft}
              disabled={!draft.publication.enabled}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  publication: { ...current.publication, draft: event.target.checked },
                }))
              }
            />
            Open as draft PR
          </label>
        </div>
        <p className="mt-2 text-xs text-text-tertiary">
          Publication authorizes pushing the factory branch and opening/updating its PR. It never
          grants permission to merge.
        </p>
        {draft.merge.mode === 'auto-merge' && (
          <p className="mt-2 text-xs text-warning">
            Auto-merge needs publication permission. Switch to human-approved merge before disabling
            publication.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border-subtle p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="mt-0.5 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Merge authority</h3>
            <p className="mt-1 text-xs text-text-secondary">
              Choose whether a person approves each current PR head or the factory may request merge
              when these gates pass.
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Field label="Merge mode">
            <select
              className={inputClass()}
              value={draft.merge.mode}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  merge: {
                    ...current.merge,
                    mode: event.target.value as FactoryDefinitionInput['merge']['mode'],
                  },
                }))
              }
            >
              <option value="human-approved">Human-approved merge</option>
              <option value="auto-merge" disabled={!draft.publication.enabled}>
                Auto-merge under policy
              </option>
            </select>
          </Field>
          <Field label="Merge method">
            <select
              className={inputClass()}
              value={draft.merge.method}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  merge: {
                    ...current.merge,
                    method: event.target.value as FactoryDefinitionInput['merge']['method'],
                  },
                }))
              }
            >
              <option value="squash">Squash</option>
              <option value="merge">Merge commit</option>
              <option value="rebase">Rebase</option>
            </select>
          </Field>
          <Field label="Required CI checks" hint="One exact provider check name per line.">
            <textarea
              className={`${inputClass()} min-h-20 resize-y`}
              value={draft.merge.requiredChecks.join('\n')}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  merge: { ...current.merge, requiredChecks: splitLines(event.target.value) },
                }))
              }
            />
          </Field>
          <label className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-secondary/40 p-3 text-sm text-text-primary">
            <input
              className="mt-1"
              type="checkbox"
              checked={draft.merge.requireApproval}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  merge: { ...current.merge, requireApproval: event.target.checked },
                }))
              }
            />
            <span>
              <span className="font-medium">Require human review approval</span>
              <span className="mt-1 block text-xs text-text-secondary">
                A factory-authored review does not satisfy a required human approval.
              </span>
            </span>
          </label>
        </div>
        {draft.merge.mode === 'auto-merge' && (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
            Auto-merge is standing authority. It is limited to this repository, base branch, merge
            method and gates, and requires owner authorization at activation.
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border-subtle p-4">
        <h3 className="text-sm font-semibold text-text-primary">Visibility and roles</h3>
        <p className="mt-1 text-xs text-text-secondary">
          Visibility controls who can discover runs. Source repository, ticket and artifact
          permissions still apply to details and evidence.
        </p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Field label="Factory access">
            <select
              className={inputClass()}
              value={draft.access.kind}
              onChange={(event) =>
                onDefinition((current) => ({
                  ...current,
                  access: withAccess(
                    current.access,
                    event.target.value as 'private' | 'organization',
                  ),
                }))
              }
            >
              <option value="private">Private to owner</option>
              <option value="organization">Share within organization</option>
            </select>
          </Field>
          {orgAccess && (
            <Field label="Organization">
              <select
                className={inputClass()}
                value={orgAccess.organizationId}
                onChange={(event) =>
                  onDefinition((current) => ({
                    ...current,
                    access:
                      current.access.kind === 'organization'
                        ? { ...current.access, organizationId: event.target.value, members: [] }
                        : current.access,
                  }))
                }
              >
                <option value="">Choose an organization</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.id} · {organization.role}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {orgAccess && (
          <>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <Field label="Visibility">
                <select
                  className={inputClass()}
                  value={orgAccess.visibility}
                  onChange={(event) =>
                    onDefinition((current) => ({
                      ...current,
                      access:
                        current.access.kind === 'organization'
                          ? {
                              ...current.access,
                              visibility: event.target.value as
                                'organization' | 'team' | 'restricted',
                            }
                          : current.access,
                    }))
                  }
                >
                  <option value="organization">Organization-wide</option>
                  <option value="team">Team/project (default)</option>
                  <option value="restricted">Restricted members</option>
                </select>
              </Field>
              {orgAccess.visibility === 'team' && (
                <Field
                  label="GitHub team slug"
                  hint="Current team membership is checked when reading or operating runs."
                >
                  <input
                    className={inputClass()}
                    value={orgAccess.teamId ?? ''}
                    onChange={(event) =>
                      onDefinition((current) => ({
                        ...current,
                        access:
                          current.access.kind === 'organization'
                            ? { ...current.access, teamId: event.target.value }
                            : current.access,
                      }))
                    }
                  />
                </Field>
              )}
            </div>
            <div className="mt-4 rounded-lg border border-border-subtle p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text-primary">
                <UserRoundCheck size={14} />
                Member roles
              </div>
              <p className="mb-2 text-xs text-text-tertiary">
                Assign enrolled organization members as viewers, operators or factory owners. New
                recipients stay pending until their encryption key is enrolled. Organization
                administrator authority is verified by the service and cannot be assigned here; team
                and organization visibility still require current membership.
              </p>
              <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
                <select
                  className={inputClass(false)}
                  aria-label="Organization member"
                  value={inviteUserId}
                  onChange={(event) => onInviteUserId(event.target.value)}
                >
                  <option value="">Choose an organization member</option>
                  {organizationMembers
                    .filter(
                      (member) =>
                        !orgAccess.members.some((current) => current.userId === member.userId),
                    )
                    .map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.userId} · {member.role}
                      </option>
                    ))}
                </select>
                <select
                  className={inputClass(false)}
                  aria-label="Factory role"
                  value={inviteRole}
                  onChange={(event) => onInviteRole(event.target.value as FactoryRole)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                  <option value="owner">Owner</option>
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!inviteUserId || !orgAccess.organizationId}
                  onClick={onAddMember}
                >
                  Add member
                </Button>
              </div>
              <div className="mt-3 space-y-1">
                {orgAccess.members.map((member) => (
                  <div
                    key={member.userId}
                    className="flex items-center justify-between gap-3 rounded-md bg-bg-secondary px-3 py-2 text-xs"
                  >
                    <span className="min-w-0 truncate text-text-primary">{member.userId}</span>
                    <select
                      aria-label={`Role for ${member.userId}`}
                      className="rounded border border-border bg-bg-primary px-2 py-1 capitalize text-text-secondary"
                      value={member.role}
                      onChange={(event) =>
                        onMemberRole(member.userId, event.target.value as FactoryRole)
                      }
                    >
                      <option value="viewer">Viewer</option>
                      <option value="operator">Operator</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      type="button"
                      className="shrink-0 text-error hover:underline"
                      onClick={() => onRemoveMember(member.userId)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {orgAccess.members.length === 0 && (
                  <p className="text-xs text-text-tertiary">
                    Add named members as operators or owners. Viewers can be granted read access.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
        <p className="mt-3 text-xs text-text-tertiary">
          Guests only see content explicitly shared with them. Organization visibility never grants
          repository access or credentials.
        </p>
      </section>

      {preview && <PreviewPanel preview={preview} title="Typed definition preview" />}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-4">
        <Button variant="secondary" onClick={onPreview} disabled={busy || !criteriaChecksMatch}>
          <RefreshCw size={14} />
          {busy ? 'Validating…' : 'Preview definition'}
        </Button>
        <Button onClick={onSave} disabled={busy || !preview}>
          <CheckCircle2 size={14} />
          Save inactive draft
        </Button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        className={inputClass()}
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(event) => onChange(Math.max(0, Math.min(max, Number(event.target.value) || 0)))}
      />
    </Field>
  );
}

function PreviewPanel({ preview, title }: { preview: FactoryPreview; title: string }) {
  return (
    <section className="rounded-xl border border-accent/30 bg-accent/5 p-4" aria-label={title}>
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-secondary">
        {preview.summary.map((line, index) => (
          <li key={`${line}-${index}`}>{line}</li>
        ))}
      </ul>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-accent">
          Inspect exact definition
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-bg-primary p-3 text-[11px] text-text-secondary">
          {JSON.stringify(preview.definition, null, 2)}
        </pre>
      </details>
    </section>
  );
}

function FactoryDetails({
  factory,
  runs,
  selectedRun,
  activationPreview,
  activating,
  busyAction,
  onEdit,
  onPrepareActivation,
  onConfirmActivation,
  onCancelActivation,
  onFactoryAction,
  onSelectRun,
  onRunAction,
  onOpenPickupThread,
  pickupRunId,
  pickupWorkspaceId,
  pickupWorkspace,
  pickupWorkspaceLoading,
  pickupPersonaId,
  pickupRepoId,
  workspaces,
  personas,
  matchingPickupRepos,
  onRequestPickup,
  onPickupWorkspace,
  onPickupPersona,
  onPickupRepo,
  onCancelPickup,
}: {
  factory: FactoryDefinition;
  runs: FactoryRun[];
  selectedRun: FactoryRun | null;
  activationPreview: FactoryPreview | null;
  activating: boolean;
  busyAction: string | null;
  onEdit: () => void;
  onPrepareActivation: () => void;
  onConfirmActivation: () => void;
  onCancelActivation: () => void;
  onFactoryAction: (action: 'pause' | 'resume' | 'deactivate') => void;
  onSelectRun: (run: FactoryRun) => void;
  onRunAction: (action: FactoryRunControlInput['action']) => void;
  onOpenPickupThread: (threadId: string) => void;
  pickupRunId: string | null;
  pickupWorkspaceId: string;
  pickupWorkspace: WorkspaceWithRepos | null;
  pickupWorkspaceLoading: boolean;
  pickupPersonaId: string;
  pickupRepoId: string;
  workspaces: Array<{ id: string; name: string }>;
  personas: Persona[];
  matchingPickupRepos: RepoInfo[];
  onRequestPickup: (run: FactoryRun) => void;
  onPickupWorkspace: (workspaceId: string) => void;
  onPickupPersona: (personaId: string) => void;
  onPickupRepo: (repoId: string) => void;
  onCancelPickup: () => void;
}) {
  if (factory.accessPending) {
    return (
      <div className="space-y-4 p-6">
        <div>
          <span className="rounded-full bg-warning/10 px-2.5 py-1 text-xs text-warning">
            Access pending
          </span>
          <h2 className="mt-3 text-xl font-semibold text-text-primary">Shared factory</h2>
        </div>
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-3 text-sm text-text-secondary">
          The shared record is encrypted for enrolled members. Your account has not completed key
          enrollment, so factory details and runs remain hidden until the owner completes
          enrollment.
        </div>
      </div>
    );
  }
  const isActive = factory.status === 'active';
  const hasUnactivatedRevision = factory.activeRevision !== factory.revision;
  const effectiveRole = effectiveFactoryRole(factory);
  const canOperate = canOperateFactory(factory);
  const canManage = canManageFactory(factory);
  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold text-text-primary">{factory.definition.name}</h2>
            <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs capitalize text-text-secondary">
              {factory.status}
            </span>
            {factory.organizationAdmin && (
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent">
                Verified organization admin
              </span>
            )}
            <span className="text-xs text-text-tertiary">
              Revision {factory.revision}
              {factory.activeRevision && factory.activeRevision !== factory.revision
                ? ` · active r${factory.activeRevision}`
                : ''}
            </span>
          </div>
          {factory.sourceAccess !== false && !factory.redacted ? (
            <p className="mt-1 text-sm text-text-secondary">
              {factory.definition.github.owner}/{factory.definition.github.repo} · issues labeled “
              {factory.definition.github.label}” · base {factory.definition.github.baseBranch}
            </p>
          ) : (
            <p className="mt-1 text-sm text-text-secondary">
              Source repository details are unavailable for your account.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit definition
            </Button>
          )}
          {canManage && (!isActive || hasUnactivatedRevision) && (
            <Button size="sm" disabled={activating} onClick={onPrepareActivation}>
              <Play size={14} />
              {activating ? 'Reviewing…' : 'Review & activate'}
            </Button>
          )}
          {canOperate && isActive && !hasUnactivatedRevision && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onFactoryAction('pause')}
            >
              <Pause size={14} />
              Pause factory
            </Button>
          )}
          {canOperate && factory.status === 'paused' && !hasUnactivatedRevision && (
            <Button
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onFactoryAction('resume')}
            >
              <Play size={14} />
              Resume factory
            </Button>
          )}
          {canManage && factory.status !== 'inactive' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onFactoryAction('deactivate')}
            >
              Deactivate
            </Button>
          )}
        </div>
      </div>
      {factory.accessPending && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
          This factory is shared, but your account has not completed key enrollment. You can only
          see this pending-access notice until the owner completes enrollment.
        </div>
      )}
      {factory.commandPending && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
          Your request was accepted and is waiting for the factory owner’s device to apply it. The
          displayed status may not reflect the change yet.
        </div>
      )}
      {!factory.accessPending && effectiveRole && (
        <p className="text-xs text-text-tertiary">
          Your factory role: <span className="capitalize">{effectiveRole}</span>
          {factory.organizationAdmin
            ? ' · organization administrator authority verified by the service'
            : ''}
          {factory.sourceAccess === false ? ' · source repository access is unavailable' : ''}
        </p>
      )}
      {factory.redacted && (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
          Some source details are hidden because you do not have permission to read them.
        </div>
      )}

      {activationPreview && (
        <section
          className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-4"
          aria-label="Factory activation review"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ShieldCheck size={17} />
            Review standing authority before activation
          </div>
          <p className="text-xs text-text-secondary">
            Activation starts issue polling under revision {factory.revision}. Confirm the
            organization, repository, user roles, publication permission, and merge policy below.
          </p>
          {!factory.remote && (
            <p className="rounded-lg border border-border-subtle bg-bg-secondary/60 px-3 py-2 text-xs text-text-secondary">
              Confirming activation also sets up and starts this device’s per-user background
              service so issue processing can continue while the app is closed. Manage the service
              from Watchtower.
            </p>
          )}
          <PreviewPanel preview={activationPreview} title="Exact activation policy" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onCancelActivation}>
              Cancel
            </Button>
            <Button disabled={activating} onClick={onConfirmActivation}>
              {activating ? 'Activating…' : 'Confirm activation'}
            </Button>
          </div>
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
        <section className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">Issue runs</h3>
            <span className="text-xs text-text-tertiary">{runs.length}</span>
          </div>
          <div className="mt-3 space-y-1">
            {runs.length === 0 ? (
              <p className="py-4 text-xs text-text-tertiary">No matching issue runs yet.</p>
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onSelectRun(run)}
                  className={`w-full rounded-lg px-3 py-3 text-left ${selectedRun?.id === run.id ? 'bg-accent/10 ring-1 ring-accent/30' : 'hover:bg-bg-tertiary'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {canReadRunSource(run)
                        ? `#${run.issue.number} ${run.issue.title}`
                        : 'Issue source unavailable'}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-tertiary">
                      {STAGE_LABELS[run.stage]}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                    <Activity size={12} />
                    {run.repairRounds} repair rounds · {formatDate(run.updatedAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
        <RunDetails
          run={selectedRun}
          onAction={onRunAction}
          onOpenPickupThread={onOpenPickupThread}
          busyAction={busyAction}
          canOperate={canOperate}
          pickupOpen={selectedRun ? pickupRunId === selectedRun.id : false}
          pickupWorkspaceId={pickupWorkspaceId}
          pickupWorkspace={pickupWorkspace}
          pickupWorkspaceLoading={pickupWorkspaceLoading}
          pickupPersonaId={pickupPersonaId}
          pickupRepoId={pickupRepoId}
          workspaces={workspaces}
          personas={personas}
          matchingPickupRepos={matchingPickupRepos}
          onRequestPickup={onRequestPickup}
          onPickupWorkspace={onPickupWorkspace}
          onPickupPersona={onPickupPersona}
          onPickupRepo={onPickupRepo}
          onCancelPickup={onCancelPickup}
        />
      </div>
    </div>
  );
}

function RunDetails({
  run,
  onAction,
  onOpenPickupThread,
  busyAction,
  canOperate,
  pickupOpen,
  pickupWorkspaceId,
  pickupWorkspace,
  pickupWorkspaceLoading,
  pickupPersonaId,
  pickupRepoId,
  workspaces,
  personas,
  matchingPickupRepos,
  onRequestPickup,
  onPickupWorkspace,
  onPickupPersona,
  onPickupRepo,
  onCancelPickup,
}: {
  run: FactoryRun | null;
  onAction: (
    action: 'pause' | 'resume' | 'cancel' | 'retry' | 'approve-merge' | 'takeover',
  ) => void;
  onOpenPickupThread: (threadId: string) => void;
  busyAction: string | null;
  canOperate: boolean;
  pickupOpen: boolean;
  pickupWorkspaceId: string;
  pickupWorkspace: WorkspaceWithRepos | null;
  pickupWorkspaceLoading: boolean;
  pickupPersonaId: string;
  pickupRepoId: string;
  workspaces: Array<{ id: string; name: string }>;
  personas: Persona[];
  matchingPickupRepos: RepoInfo[];
  onRequestPickup: (run: FactoryRun) => void;
  onPickupWorkspace: (workspaceId: string) => void;
  onPickupPersona: (personaId: string) => void;
  onPickupRepo: (repoId: string) => void;
  onCancelPickup: () => void;
}) {
  if (!run)
    return (
      <section className="grid min-h-48 place-items-center rounded-xl border border-dashed border-border p-6 text-sm text-text-tertiary">
        Select an issue run to inspect its progress and receipts.
      </section>
    );
  const terminal = ['completed', 'cancelled', 'taken-over'].includes(run.stage);
  const isAutoMerge = run.snapshot.definition.merge.mode === 'auto-merge';
  const sourceAccess = canReadRunSource(run);
  return (
    <section
      className="min-w-0 rounded-xl border border-border-subtle p-4"
      aria-label="Factory run details"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-accent">
            {sourceAccess ? `Issue #${run.issue.number}` : 'Issue source'}
          </div>
          <h3 className="mt-1 text-base font-semibold text-text-primary">
            {sourceAccess ? run.issue.title : 'Source issue details are unavailable'}
          </h3>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-tertiary">
            <span>{STAGE_LABELS[run.stage]}</span>
            <span>Revision {run.revision}</span>
            <span>{run.commandsUsed} commands</span>
            <span>{run.repairRounds} repairs</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {sourceAccess && run.issue.url && (
            <a
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              href={run.issue.url}
              target="_blank"
              rel="noreferrer"
            >
              Source issue <ExternalLink size={12} />
            </a>
          )}
          {sourceAccess && run.pullRequest && (
            <a
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              href={run.pullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              PR #{run.pullRequest.number} <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>
      {run.pendingControl === 'cancel' && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
          Cancellation is awaiting provider reconciliation. The run is not marked cancelled until
          GitHub confirms the queued or automatic merge work is clear.
        </div>
      )}
      {run.pendingControl === 'takeover' && !run.takeoverThreadId && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
          Pickup is waiting for the owner’s device to pause the live run. A private chat will be
          created on this device after the claimed run snapshot is available.
        </div>
      )}
      {run.takeoverThreadId && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">
          <span>A private pickup chat is ready in your selected workspace.</span>
          <Button size="sm" onClick={() => onOpenPickupThread(run.takeoverThreadId!)}>
            Open pickup chat
          </Button>
        </div>
      )}
      {sourceAccess && run.error && (
        <p className="mt-3 rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
          {run.error}
        </p>
      )}
      {sourceAccess && run.issue.body && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-text-secondary">
            Issue description
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary">
            {run.issue.body}
          </p>
        </details>
      )}
      {sourceAccess && run.observation && (
        <div className="mt-4 rounded-lg bg-bg-secondary p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-text-primary">
              PR status at {formatDate(run.observation.observedAt)}
            </h4>
            <span className="text-xs capitalize text-text-secondary">
              {run.observation.state} · {run.observation.review.replaceAll('-', ' ')}
            </span>
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-text-tertiary">
            Head {run.observation.headSha}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {run.observation.checks.map((check) => (
              <span
                key={`${check.name}-${check.headSha}`}
                className={`rounded-full px-2 py-1 text-[10px] ${check.status === 'passed' ? 'bg-success/10 text-success' : check.status === 'failed' ? 'bg-error/10 text-error' : 'bg-bg-tertiary text-text-tertiary'}`}
              >
                {check.name}: {check.status}
              </span>
            ))}
          </div>
        </div>
      )}
      {sourceAccess && run.evidence && (
        <EvidencePanel title="Pre-publication evidence" evidence={run.evidence} />
      )}
      {sourceAccess && run.postMergeEvidence && (
        <EvidencePanel title="Post-merge evidence" evidence={run.postMergeEvidence} />
      )}
      <div className="mt-4 border-t border-border-subtle pt-3">
        <h4 className="text-xs font-semibold text-text-primary">Receipts</h4>
        <ol className="mt-2 space-y-2">
          {run.receipts.map((receipt) => (
            <li key={receipt.id} className="flex min-w-0 items-start justify-between gap-3 text-xs">
              <span className="min-w-0">
                <span className="font-medium capitalize text-text-primary">
                  {receipt.kind.replaceAll('-', ' ')}
                </span>
                <span className="ml-2 text-text-tertiary">{receipt.status}</span>
                {sourceAccess && receipt.error && (
                  <span className="mt-0.5 block break-words text-error">{receipt.error}</span>
                )}
              </span>
              <time className="shrink-0 text-[10px] text-text-tertiary">
                {formatDate(receipt.updatedAt)}
              </time>
            </li>
          ))}
        </ol>
      </div>
      {!terminal && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
          {canOperate && run.stage !== 'paused' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onAction('pause')}
            >
              <Pause size={13} />
              Pause
            </Button>
          )}
          {canOperate && run.stage === 'paused' && (
            <Button size="sm" disabled={busyAction !== null} onClick={() => onAction('resume')}>
              <Play size={13} />
              Resume
            </Button>
          )}
          {canOperate && run.stage === 'blocked' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onAction('retry')}
            >
              <RefreshCw size={13} />
              Retry after reconcile
            </Button>
          )}
          {canOperate && run.stage === 'awaiting-merge-approval' && !isAutoMerge && (
            <Button
              size="sm"
              disabled={busyAction !== null || !run.observation?.headSha}
              onClick={() => onAction('approve-merge')}
            >
              <GitPullRequest size={13} />
              Approve merge at current head
            </Button>
          )}
          {canOperate && run.stage === 'awaiting-merge-approval' && isAutoMerge && (
            <span className="rounded-lg border border-border-subtle px-3 py-2 text-xs text-text-secondary">
              This run follows its active auto-merge policy.
            </span>
          )}
          {canOperate && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busyAction !== null || Boolean(run.pendingControl)}
              onClick={() => onRequestPickup(run)}
            >
              <ArrowRight size={13} />
              Pick up thread
            </Button>
          )}
          {canOperate && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onAction('cancel')}
            >
              Cancel run
            </Button>
          )}
        </div>
      )}
      {pickupOpen && !terminal && canOperate && (
        <section
          className="mt-4 space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3"
          aria-label="Pick up issue run"
        >
          <div>
            <h4 className="text-sm font-semibold text-text-primary">
              Create a private pickup chat
            </h4>
            <p className="mt-1 text-xs text-text-secondary">
              Choose your own workspace and persona. A matching local repository adds source
              context; otherwise the chat receives the shared issue and run snapshot only. Nothing
              is sent and no agent turn starts.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Your workspace">
              <select
                className={inputClass()}
                value={pickupWorkspaceId}
                onChange={(event) => onPickupWorkspace(event.target.value)}
              >
                <option value="">Choose workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Persona">
              <select
                className={inputClass()}
                value={pickupPersonaId}
                onChange={(event) => onPickupPersona(event.target.value)}
              >
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Local source repository"
            hint="Only a local checkout matching the shared GitHub source can be attached for code context."
          >
            <select
              className={inputClass(pickupWorkspaceLoading)}
              value={pickupRepoId}
              disabled={pickupWorkspaceLoading || !pickupWorkspaceId}
              onChange={(event) => onPickupRepo(event.target.value)}
            >
              <option value="">Snapshot only — no local checkout</option>
              {matchingPickupRepos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </Field>
          {pickupWorkspaceId && !pickupWorkspaceLoading && matchingPickupRepos.length === 0 && (
            <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-secondary">
              No matching local checkout is available in {pickupWorkspace?.name ?? 'this workspace'}
              . The pickup chat will have the approved shared snapshot, but no live repository
              context for commands.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-3">
            <Button variant="secondary" size="sm" onClick={onCancelPickup}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                busyAction !== null ||
                !pickupWorkspaceId ||
                !pickupPersonaId ||
                pickupWorkspaceLoading
              }
              onClick={() => onAction('takeover')}
            >
              <ArrowRight size={13} />
              Create private pickup chat
            </Button>
          </div>
        </section>
      )}
      {run.stage === 'completed' && sourceAccess && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
          <CheckCircle2 size={14} />
          Provider confirmed merge and post-merge verification completed.
        </div>
      )}
    </section>
  );
}

function EvidencePanel({
  title,
  evidence,
}: {
  title: string;
  evidence: NonNullable<FactoryRun['evidence']>;
}) {
  return (
    <details className="mt-3 rounded-lg border border-border-subtle p-3">
      <summary className="cursor-pointer text-xs font-semibold text-text-primary">
        {title} · {evidence.passed ? 'passed' : 'needs attention'} · {evidence.criteria.length}{' '}
        criteria
      </summary>
      <div className="mt-2 space-y-2">
        {evidence.criteria.map((criterion, index) => (
          <div
            key={`${criterion.criterion}-${index}`}
            className="rounded-md bg-bg-secondary px-3 py-2 text-xs"
          >
            <div className="font-medium text-text-primary">
              {criterion.status === 'passed' ? '✓' : criterion.status === 'failed' ? '✕' : '•'}{' '}
              {criterion.criterion}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">
              {criterion.evidence}
            </p>
          </div>
        ))}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-text-tertiary">
          Commands and outputs
        </summary>
        <div className="mt-2 space-y-2">
          {evidence.commands.map((command, index) => (
            <div key={`${command.command}-${index}`} className="rounded-md bg-bg-primary p-2">
              <code className="break-all text-[11px] text-text-primary">{command.command}</code>
              <span className="ml-2 text-[10px] text-text-tertiary">
                exit {command.exitCode ?? 'unknown'}
              </span>
              <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[10px] text-text-secondary">
                {command.output}
              </pre>
            </div>
          ))}
        </div>
      </details>
    </details>
  );
}

function EmptyFactories({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto grid min-h-full max-w-xl place-items-center p-8 text-center">
      <div>
        <Factory className="mx-auto text-accent" size={34} />
        <h2 className="mt-4 text-lg font-semibold text-text-primary">
          Turn a ticket into a reviewed change
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          Describe the issue trigger, workflow, checks and merge policy. Mezair will show the exact
          typed definition before saving or activating it.
        </p>
        <Button className="mt-4" onClick={onCreate}>
          <Plus size={15} />
          Create factory
        </Button>
      </div>
    </div>
  );
}
