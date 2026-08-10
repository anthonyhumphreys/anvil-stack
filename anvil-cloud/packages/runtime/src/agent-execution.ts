import type {
  AgentManifest,
  AgentNetworkCapability,
  AgentTokenUsage,
} from "./agent.js";
import type {
  AgentSandboxProvider,
  AgentSandboxSession,
} from "./agent-sandbox.js";

export const AGENT_EXECUTION_SCHEMA_VERSION = "0.1" as const;

export type AgentExecutionMode = "read-only" | "read-write";

export type AgentExecutionStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting-for-approval"
  | "waiting-for-input"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type AgentExecutionProviderPreference =
  | { kind: "auto" }
  | { kind: "provider"; provider: string };

export type AgentExecutionSourceSelection = {
  includesWorkingTreePatch: boolean;
  excluded: Array<
    | "git-metadata"
    | "ignored-files"
    | "secret-files"
    | "unrelated-untracked-files"
  >;
};

export type AgentExecutionSource =
  | {
      kind: "git";
      repository: string;
      commit: string;
      branch?: string;
      subdirectory?: string;
      selection: AgentExecutionSourceSelection;
    }
  | {
      kind: "snapshot";
      snapshotId: string;
      sha256: string;
      sizeBytes: number;
      baseCommit: string;
      repository?: string;
      branch?: string;
      patch?: {
        artifactId: string;
        sha256: string;
        sizeBytes: number;
      };
      selection: AgentExecutionSourceSelection;
    };

export type AgentExecutionArtifact = {
  id: string;
  name: string;
  kind: "canvas" | "evidence" | "log" | "patch" | "report" | "test-output";
  storage: "repository" | "session";
  sha256: string;
  sizeBytes: number;
  downloadUrl?: string;
  mediaType?: string;
};

export type AgentExecutionPolicy = {
  mode: AgentExecutionMode;
  ttlSeconds: number;
  network: AgentNetworkCapability;
  maxCostUsd?: number;
  maxEvents?: number;
  requireApprovalForExternalActions: boolean;
};

export type AgentExecutionModelAuth =
  | {
      kind: "control-plane";
      credential: string;
    }
  | {
      /**
       * Use an interactive provider login inside the ephemeral execution
       * session. No API key or reusable local auth cache crosses the boundary.
       */
      kind: "provider-subscription";
      provider: "codex" | "cursor";
      persistence: "sandbox-session";
    };

export type AgentExecutionRequest = {
  schemaVersion: typeof AGENT_EXECUTION_SCHEMA_VERSION;
  clientToken: string;
  workspace: string;
  cell: string;
  environment: string;
  task: string;
  agent: AgentManifest;
  source: AgentExecutionSource;
  providerPreference: AgentExecutionProviderPreference;
  policy: AgentExecutionPolicy;
  modelAuth: AgentExecutionModelAuth;
};

export type AgentExecutionEventType =
  | "execution.created"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"
  | "sandbox.started"
  | "sandbox.suspended"
  | "sandbox.resumed"
  | "sandbox.terminated"
  | "agent.message"
  | "agent.reasoning"
  | "tool.started"
  | "tool.completed"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "file.changed"
  | "subagent.started"
  | "subagent.completed"
  | "approval.requested"
  | "approval.resolved"
  | "input.requested"
  | "input.submitted"
  | "artifact.available"
  | "patch.ready"
  | "usage.updated"
  | "heartbeat"
  | "expiry.warning"
  | "cleanup.completed";

export type AgentExecutionProviderEvent = {
  id: string;
  type: AgentExecutionEventType;
  timestamp?: string;
  data: Record<string, unknown>;
};

export type AgentExecutionEvent = AgentExecutionProviderEvent & {
  executionId: string;
  sequence: number;
  cursor: string;
  timestamp: string;
};

export type AgentExecutionEventBatch = {
  events: AgentExecutionProviderEvent[];
  cursor?: string;
  done: boolean;
};

export type AgentExecutionHandle = {
  sessionId: string;
  runId: string;
};

export type AgentExecutionWorkspace = {
  id: string;
  source: AgentExecutionSource;
  writable: boolean;
  metadata: Record<string, unknown>;
};

/**
 * Ephemeral source access passed directly to a provider. It must never be
 * written into an execution lease, event, result, or artifact manifest.
 */
export type AgentExecutionSourceAccess = {
  kind: "control-plane-grant";
  endpoint: string;
  grantId: string;
  token: string;
  expiresAt: string;
};

export type AgentExecutionStartInput = {
  executionId: string;
  task: string;
  source: AgentExecutionSource;
  policy: AgentExecutionPolicy;
  modelAuth: AgentExecutionRequest["modelAuth"];
};

export type AgentExecutionApprovalDecision = {
  requestId: string;
  decision: "approved" | "rejected";
  actor: string;
  reason?: string;
};

export type AgentExecutionInputSubmission = {
  requestId: string;
  values: Record<string, unknown>;
};

export type AgentExecutionCommandEvidence = {
  command: string;
  exitCode: number | null;
  durationMs?: number;
  outputArtifactId?: string;
};

export type AgentExecutionTestEvidence = {
  command: string;
  status: "passed" | "failed" | "skipped";
  summary?: string;
  outputArtifactId?: string;
};

export type AgentExecutionProviderResult = {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  changedFiles: string[];
  artifacts: AgentExecutionArtifact[];
  commands: AgentExecutionCommandEvidence[];
  tests: AgentExecutionTestEvidence[];
  errors: Array<{ code: string; message: string }>;
  evidence: Array<{ label: string; value: string }>;
  usage?: AgentTokenUsage & {
    estimatedCostUsd?: number;
    provider?: string;
  };
  patch?: AgentExecutionArtifact;
};

export type AgentExecutionProviderCapabilities = {
  modes: readonly AgentExecutionMode[];
  modelAuth: readonly AgentExecutionModelAuth["kind"][];
  subscriptionProviders?: readonly Extract<
    AgentExecutionModelAuth,
    { kind: "provider-subscription" }
  >["provider"][];
  maxTtlSeconds: number;
  resumableEvents: boolean;
  approvals: boolean;
  input: boolean;
  steering: boolean;
  artifacts: boolean;
  patches: boolean;
};

export type AgentExecutionProviderSupport = {
  supported: boolean;
  reasons: string[];
};

/**
 * Provider-owned sandbox lifecycle plus the normalised execution transport.
 * Implementations may use HTTP, WebSocket, queues, or another private
 * transport, but callers only see cursor-based JSON events and typed control
 * operations.
 */
export interface AgentExecutionProvider extends AgentSandboxProvider {
  readonly executionCapabilities: AgentExecutionProviderCapabilities;
  supports(request: AgentExecutionRequest): AgentExecutionProviderSupport;
  prepareWorkspace(
    session: AgentSandboxSession,
    input: {
      executionId: string;
      source: AgentExecutionSource;
      access?: AgentExecutionSourceAccess;
    },
  ): Promise<AgentExecutionWorkspace>;
  startExecution(
    session: AgentSandboxSession,
    input: AgentExecutionStartInput,
  ): Promise<AgentExecutionHandle>;
  readEvents(
    handle: AgentExecutionHandle,
    options?: { cursor?: string; limit?: number },
  ): Promise<AgentExecutionEventBatch>;
  resolveApproval(
    handle: AgentExecutionHandle,
    decision: AgentExecutionApprovalDecision,
  ): Promise<void>;
  submitInput(
    handle: AgentExecutionHandle,
    input: AgentExecutionInputSubmission,
  ): Promise<void>;
  steer(handle: AgentExecutionHandle, message: string): Promise<void>;
  collectResult(
    handle: AgentExecutionHandle,
  ): Promise<AgentExecutionProviderResult>;
}
