import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MESH_MACHINE_PROTOCOL_VERSION } from '../../../../../cloud/contract/machine';
import type { CloudAgentSettingsSnapshot } from '../../../../shared/cloud-agent';
import type { CredentialStorageStatus } from '../../../../shared/secret-storage';
import type { SyncBackendStatus } from '../../../../shared/sync-backend';
import type { SyncDeviceSecurityStatus } from '../../../../shared/sync-device-security';
import type {
  ApprovalRecord,
  ExecutionAttempt,
  HandoffRecord,
  JobSummary,
  SessionMeshState,
  SyncAttemptActivity,
  SyncConflictView,
  SyncDevice,
  SyncRuntimeStatus,
} from '../../../../shared/sync-runtime';
import { SessionOwnershipChip } from '../SessionOwnershipChip';
import { MeshExecutionsPanel } from '../../settings/MeshExecutionsPanel';
import { SyncMeshSettingsPanel } from '../../settings/SyncMeshSettingsPanel';

/*
 * Development-only Sync & Mesh fixture for the standalone replay preview.
 * Production settings, Mesh job and session ownership components render
 * against an in-memory account. No backend, worker, provider or key is used.
 *
 *   ?mesh            full Settings → Sync & Mesh panel
 *   ?mesh=jobs       Mesh jobs with a live attempt stream and a pending approval
 *   ?mesh=session    session ownership: idle with Move open, and mid-handoff
 */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const SELF = 'enr_7c41d2a9e0b54f18';
const STUDIO = 'enr_3f9b6a11c8d24e70';
const BUILD = 'enr_b52e09d7a6f34c81';
const RETIRED = 'enr_0a7d33e5f19b4c26';
const LOCAL_WORKER = 'wrk_91d0c6e2b7a84f35';
const STUDIO_WORKER = 'wrk_e83a51f0c2d94b67';
const BUILD_WORKER = 'wrk_4c7f2b98d1e04a53';

const devices: SyncDevice[] = [
  {
    enrollmentId: SELF,
    displayName: 'Dana’s MacBook Pro',
    installationId: 'ins_laptop',
    revoked: false,
    createdAt: '2026-09-02T09:14:00.000Z',
    self: true,
    enrollmentClass: 'device',
    trustState: 'trusted',
    trustSource: 'first-device',
  },
  {
    enrollmentId: STUDIO,
    displayName: 'studio-mac',
    installationId: 'ins_studio',
    revoked: false,
    createdAt: '2026-09-02T09:31:00.000Z',
    self: false,
    enrollmentClass: 'device',
    trustState: 'trusted',
    trustSource: 'pairing',
  },
  {
    enrollmentId: BUILD,
    displayName: 'build-box (Linux)',
    installationId: 'ins_build',
    revoked: false,
    createdAt: '2026-09-18T17:02:00.000Z',
    self: false,
    enrollmentClass: 'device',
    trustState: 'trusted',
    trustSource: 'manual-approval',
  },
  {
    enrollmentId: RETIRED,
    displayName: 'old-imac',
    installationId: 'ins_retired',
    revoked: true,
    createdAt: '2026-06-11T08:40:00.000Z',
    self: false,
    enrollmentClass: 'device',
    trustState: 'revoked',
    trustSource: 'pairing',
  },
];

const manifest = (commit: string) => ({
  workspaceDefinitionRevision: 'wsd_acme_r42',
  repositories: [{ repositoryId: 'repo_storefront', commit }],
  bootstrapDigest: 'sha256:5d1c0e7a',
  provider: 'codex',
  model: 'gpt-6.1-sol',
  configVersions: { agents: '7', rules: '3' },
  inputs: {},
});

const job = (
  id: string,
  kind: JobSummary['kind'],
  state: JobSummary['state'],
  target: string | undefined,
  placementExplanation: string | null,
  extra: Partial<JobSummary> = {},
): JobSummary => ({
  id,
  requestId: `req_${id}`,
  payloadHash: `sha256:${id}`,
  kind,
  sourceEnrollmentId: SELF,
  requestedTarget: target ? { kind: 'device', enrollmentId: target } : { kind: 'auto' },
  targetEnrollmentId: target,
  inputManifest: manifest('3f9c2e1'),
  state,
  queueDeadline: minutesFromNow(30),
  retryPolicy: 'inspect-before-retry',
  placementExplanation,
  keyDelivery: 'delivered',
  ...extra,
});

const jobs: JobSummary[] = [
  job('8d2f61c4a9b0e7f3', 'start-session', 'running', STUDIO, 'pinned to studio-mac'),
  job('c47a09e2f5d13b86', 'code-task', 'awaiting-approval', BUILD, 'linux + docker required'),
  job('1b9e7d30c6a24f58', 'diagnostic', 'completed', BUILD, 'auto: build-box has linux'),
  job('f0a3c58e21d74b96', 'prepare-workspace', 'unknown-outcome', STUDIO, 'pinned to studio-mac', {
    stateReason: 'Worker lease expired while preparing; the result was never reported.',
  }),
  job('6e14b2d9f8a03c57', 'code-task', 'cancel-requested', STUDIO, 'pinned to studio-mac'),
];

const attempts: Record<string, ExecutionAttempt[]> = {
  '8d2f61c4a9b0e7f3': [
    {
      id: 'att_5a0e93c1d7f24b68',
      jobId: '8d2f61c4a9b0e7f3',
      workerIncarnation: STUDIO_WORKER,
      fence: 3,
      leaseExpiresAt: minutesFromNow(4),
      state: 'running',
    },
  ],
  c47a09e2f5d13b86: [
    {
      id: 'att_e2c71f08b94d3a56',
      jobId: 'c47a09e2f5d13b86',
      workerIncarnation: BUILD_WORKER,
      fence: 1,
      leaseExpiresAt: minutesFromNow(9),
      state: 'preparing',
    },
  ],
  '1b9e7d30c6a24f58': [
    {
      id: 'att_09b4e6d2c1a87f35',
      jobId: '1b9e7d30c6a24f58',
      workerIncarnation: BUILD_WORKER,
      fence: 1,
      leaseExpiresAt: minutesAgo(40),
      state: 'completed',
    },
  ],
};

const approvals: Record<string, ApprovalRecord[]> = {
  c47a09e2f5d13b86: [
    {
      id: 'apr_71c0d9e3b2a54f86',
      jobId: 'c47a09e2f5d13b86',
      attemptId: 'att_e2c71f08b94d3a56',
      actionDigest: 'sha256:b7e40c9a1f2d6e83',
      details:
        'Bootstrap recipe for acme/storefront\n$ pnpm install --frozen-lockfile\n$ pnpm exec playwright install chromium',
      generation: 1,
      approverRole: 'user',
      state: 'pending',
      expiresAt: minutesFromNow(14),
      createdAt: minutesAgo(1),
    },
  ],
};

const activityScript: Array<Pick<SyncAttemptActivity, 'kind' | 'text'>> = [
  { kind: 'status', text: 'claimed by studio-mac · fence 3' },
  { kind: 'status', text: 'checking out acme/storefront at 3f9c2e1' },
  { kind: 'stdout', text: 'worktree clean · commit verified' },
  { kind: 'stdout', text: '$ pnpm install --frozen-lockfile' },
  { kind: 'stdout', text: 'Packages: +412 · done in 6.1s' },
  { kind: 'status', text: 'codex session started · gpt-6.1-sol · xhigh · ask for extra access' },
  { kind: 'stdout', text: 'read src/lib/retry.ts' },
  { kind: 'stdout', text: '$ pnpm test -- retry' },
  { kind: 'stderr', text: 'FAIL retries five times: expected 5, received 3' },
  { kind: 'stdout', text: 'edit src/lib/retry.ts  +1 −1' },
  { kind: 'stdout', text: '$ pnpm test' },
  { kind: 'stdout', text: '✓ 14 passed (1.9s)' },
];

const handoff = (state: HandoffRecord['state']): HandoffRecord => ({
  id: 'hof_2b7e91c0',
  sessionId: 'session-moving',
  state,
  sourceEnrollmentId: SELF,
  targetEnrollmentId: STUDIO,
  sourceGeneration: 4,
  targetGeneration: null,
  checkpoint: null,
  cancelledFrom: null,
  cancelReason: null,
  createdAt: minutesAgo(1),
  updatedAt: minutesAgo(0),
});

const sessionStates: Record<string, SessionMeshState> = {
  'session-idle': { ownership: null, handoffs: [] },
  'session-moving': {
    ownership: { state: 'owned', generation: 4, ownerEnrollmentId: SELF },
    handoffs: [handoff('source-quiescing')],
  },
};

const backendStatus: SyncBackendStatus = {
  connectionMode: 'cloudflare',
  backendId: 'bk_acme_cf',
  baseUrl: 'https://sync.acme.example/',
  deploymentId: 'dep_acme_sync',
  displayName: 'Acme Sync (Cloudflare)',
  profiles: ['sync/2', 'mesh/2'],
  authModes: ['oidc-pkce'],
  state: 'active',
  identityReviewRequired: false,
  hostedBackendUrl: null,
};

const runtimeStatus: SyncRuntimeStatus = {
  auth: {
    state: 'signed-in',
    accountId: 'acct_acme_dana',
    enrollmentId: SELF,
    expiresAt: minutesFromNow(50),
  },
  datasetEpoch: 'epoch-3',
  syncEnabled: true,
  devSpikeAvailable: false,
  connectionState: 'live',
  backendIdentityReviewRequired: false,
  pendingCount: 0,
  conflictCount: 1,
  rejectedCount: 0,
  quotaExceeded: false,
  recovering: false,
  sessionExpired: false,
  meshWorker: {
    enabled: true,
    maxPermissionMode: 'on-request',
    connected: true,
    workerIncarnation: LOCAL_WORKER,
    leaseExpiresAt: minutesFromNow(5),
    activeAttempts: 0,
    lastError: null,
  },
  meshHost: {
    enabled: true,
    running: true,
    state: 'listening',
    machineId: 'mch_laptop',
    endpointGeneration: 'gen-12',
    protocolVersion: MESH_MACHINE_PROTOCOL_VERSION,
    capabilities: ['machine.session/1', 'machine.stream/1'],
    activeSessions: 1,
    managedOrigin: null,
  },
  meshHosts: [
    {
      enrollmentId: STUDIO,
      state: 'live',
      route: 'private',
      path: 'direct',
      capabilities: ['machine.session/1', 'machine.stream/1'],
    },
    {
      enrollmentId: BUILD,
      state: 'live',
      route: 'https',
      path: 'https',
      capabilities: ['machine.session/1'],
    },
  ],
  hosted: null,
  lastError: null,
  lastPushAt: minutesAgo(1),
  lastPullAt: new Date(Date.now() - 20_000).toLocaleTimeString(),
};

const security: SyncDeviceSecurityStatus = {
  accountId: 'acct_acme_dana',
  configured: true,
  policy: 'require-approval',
  revision: 6,
  recoveryRevision: 2,
  trustState: 'trusted',
  trustSource: 'first-device',
  hasAccountKey: true,
  hasRecoverySecret: true,
  canConfigure: true,
  requiresRecovery: false,
  recentEvents: [
    {
      kind: 'device-approved',
      occurredAt: '2026-09-18T17:04:00.000Z',
      source: 'manual-approval',
      enrollmentId: BUILD,
    },
    {
      kind: 'device-revoked',
      occurredAt: '2026-10-02T11:20:00.000Z',
      source: 'local-device',
      enrollmentId: RETIRED,
    },
  ],
};

const conflicts: SyncConflictView[] = [
  {
    id: 'cfl_review_template',
    entityType: 'workflow-template',
    entityId: 'tpl_pr_review',
    kind: 'edit-edit',
    localLabel: 'PR review — security pass',
    remoteLabel: 'PR review — security pass',
    localPayloadJson: JSON.stringify({
      name: 'PR review — security pass',
      nodes: [1, 2, 3, 4],
      edges: [1, 2, 3],
    }),
    remotePayloadJson: JSON.stringify({
      name: 'PR review — security pass',
      nodes: [1, 2, 3],
      edges: [1, 2],
    }),
  },
];

const cloudAgents: CloudAgentSettingsSnapshot = {
  mezairCloudAgentsEnabled: false,
  providers: [
    { provider: 'codex', enabled: true, connected: true, connectionState: 'connected' },
    { provider: 'cursor', enabled: false, connected: false, connectionState: 'disconnected' },
  ],
};

export function installMeshPreviewBridge(): void {
  const bridge = window.mezair as unknown as Record<string, unknown>;
  const overrides: Record<string, unknown> = {
    status: async () => structuredClone(runtimeStatus),
    refreshHostedEntitlement: async () => null,
    preview: async () => [],
    conflicts: async () => structuredClone(conflicts),
    listDevices: async () => structuredClone(devices),
    getDeviceSecurityStatus: async () => structuredClone(security),
    listMeshJobs: async () => structuredClone(jobs),
    listMeshHandoffs: async () => [handoff('source-quiescing')],
    getMeshJob: async (jobId: string) => ({
      job: jobs.find((item) => item.id === jobId),
      attempts: structuredClone(attempts[jobId] ?? []),
    }),
    getMeshApprovals: async (jobId: string) => structuredClone(approvals[jobId] ?? []),
    observeAttemptActivity: (_attemptId: string, push: (item: SyncAttemptActivity) => void) => {
      let sequence = 0;
      const emit = () => {
        const line = activityScript[sequence];
        if (!line) return;
        push({ ...line, at: new Date().toISOString(), sequence, gapBefore: sequence === 7 });
        sequence += 1;
      };
      for (let index = 0; index < 6; index += 1) emit();
      const timer = window.setInterval(emit, 900);
      return () => window.clearInterval(timer);
    },
    getSessionMeshState: async (sessionId: string) => structuredClone(sessionStates[sessionId]),
    listDashboardRequests: async () => [],
    listDashboardWorkspaces: async () => [],
    listCloudProviderConnections: async () => [],
    listCloudEnvironments: async () => ({ environments: [] }),
    listLocalCloudEnvironments: async () => [],
    diagnostics: async () => ({}),
  };
  bridge.syncRuntime = new Proxy(overrides, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : async () => {
            throw new Error(`Synthetic Sync & Mesh preview: ${key} is not available.`);
          },
  });
  bridge.syncBackend = {
    status: async () => structuredClone(backendStatus),
    integrationPrompt: async () => 'Synthetic preview: no prompt.',
  };
  bridge.cloudAgentSettings = { get: async () => structuredClone(cloudAgents) };
  bridge.settings = {
    getSecretStorageStatus: async (): Promise<CredentialStorageStatus> => ({
      provider: 'keychain',
      state: 'ready',
      keychainAvailable: true,
      keyFileSupported: true,
      vault: { configured: false, state: 'unavailable' },
      credentials: {},
    }),
  };
}

function Frame({ children, width }: { children: ReactNode; width: string }) {
  return (
    <div
      className="h-screen overflow-y-auto bg-bg-primary px-8 py-8 text-text-primary"
      data-capture-frame
    >
      <div className={`mx-auto ${width}`} data-mesh-capture>
        {children}
      </div>
    </div>
  );
}

/** Opens the account section so devices, jobs and permissions are visible. */
function useOpenAccountDetails() {
  useEffect(() => {
    const timer = window.setInterval(() => {
      const details = [...document.querySelectorAll('details')].find((candidate) =>
        candidate.querySelector('summary')?.textContent?.startsWith('Account, devices'),
      );
      if (details) {
        details.open = true;
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);
}

function SettingsFixture() {
  useOpenAccountDetails();
  return (
    <Frame width="max-w-3xl">
      <h3 className="mb-1 text-lg font-semibold">Sync & Mesh</h3>
      <p className="mb-5 text-sm text-text-secondary">
        Keep state in step and run jobs on trusted devices.
      </p>
      <SyncMeshSettingsPanel />
    </Frame>
  );
}

function JobsFixture() {
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const rows = [...document.querySelectorAll<HTMLButtonElement>('[aria-expanded]')];
      const first = rows.find((row) => row.textContent?.includes('start-session'));
      if (first) {
        first.click();
        window.clearInterval(timer);
        window.setTimeout(() => {
          const watch = [...document.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === 'Watch',
          );
          watch?.click();
        }, 300);
      }
      if (tries > 50) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Frame width="max-w-2xl">
      <MeshExecutionsPanel localWorkerIncarnation={LOCAL_WORKER} />
    </Frame>
  );
}

function ApprovalFixture() {
  useEffect(() => {
    const timer = window.setInterval(() => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('[aria-expanded]')].find(
        (candidate) => candidate.textContent?.includes('code-task · c47a'),
      );
      if (row) {
        row.click();
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <Frame width="max-w-2xl">
      <MeshExecutionsPanel localWorkerIncarnation={LOCAL_WORKER} />
    </Frame>
  );
}

function SessionFixture() {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened) return;
    const timer = window.setInterval(() => {
      const move = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Move session',
      );
      if (move) {
        move.click();
        setOpened(true);
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [opened]);
  return (
    <Frame width="max-w-xl">
      <div className="space-y-6">
        <div
          className="overflow-hidden rounded-lg border border-border bg-bg-secondary"
          data-session="idle"
        >
          <p className="px-3 pt-3 text-sm font-medium">Retry limit on flaky networks</p>
          <p className="px-3 pb-2 text-xs text-text-tertiary">Codex · Working · 4 actions</p>
          <SessionOwnershipChip sessionId="session-idle" provider="codex" />
        </div>
        <div
          className="overflow-hidden rounded-lg border border-border bg-bg-secondary"
          data-session="moving"
        >
          <p className="px-3 pt-3 text-sm font-medium">Retry limit on flaky networks</p>
          <p className="px-3 pb-2 text-xs text-text-tertiary">Codex · Paused for handoff</p>
          <SessionOwnershipChip sessionId="session-moving" provider="codex" />
        </div>
      </div>
    </Frame>
  );
}

export function MeshPreview() {
  const view = new URLSearchParams(window.location.search).get('mesh');
  if (view === 'jobs') return <JobsFixture />;
  if (view === 'approval') return <ApprovalFixture />;
  if (view === 'session') return <SessionFixture />;
  return <SettingsFixture />;
}
