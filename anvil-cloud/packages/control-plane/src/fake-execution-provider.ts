import { randomUUID } from "node:crypto";

import type {
  AgentExecutionApprovalDecision,
  AgentExecutionEventBatch,
  AgentExecutionHandle,
  AgentExecutionInputSubmission,
  AgentExecutionProvider,
  AgentExecutionProviderEvent,
  AgentExecutionProviderResult,
  AgentExecutionRequest,
  AgentExecutionStartInput,
  AgentExecutionWorkspace,
  AgentSandboxSession,
  AgentSandboxStartInput,
} from "@anvil-cloud/runtime";

type FakeSession = {
  session: AgentSandboxSession;
  input: AgentSandboxStartInput;
  workspace?: AgentExecutionWorkspace;
};

type FakeRun = {
  handle: AgentExecutionHandle;
  session: FakeSession;
  input: AgentExecutionStartInput;
  events: AgentExecutionProviderEvent[];
  done: boolean;
  approvalRequestId?: string;
  result?: AgentExecutionProviderResult;
};

export type FakeAgentExecutionProviderOptions = {
  idFactory?: () => string;
  now?: () => Date;
};

/**
 * Deterministic provider used by the execution conformance suite. It exercises
 * the real lifecycle, cursor, approval, patch, result, and cleanup contracts
 * without a network or cloud account.
 */
export class FakeAgentExecutionProvider implements AgentExecutionProvider {
  readonly id = "fake-execution";
  readonly executionCapabilities = {
    modes: ["read-only", "read-write"],
    modelAuth: ["control-plane", "provider-subscription"],
    subscriptionProviders: ["codex", "cursor"],
    maxTtlSeconds: 28_800,
    resumableEvents: true,
    approvals: true,
    input: true,
    steering: true,
    artifacts: true,
    patches: true,
  } as const;

  private readonly sessions = new Map<string, FakeSession>();
  private readonly runs = new Map<string, FakeRun>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: FakeAgentExecutionProviderOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  supports(request: AgentExecutionRequest) {
    const reasons: string[] = [];

    if (!this.executionCapabilities.modes.includes(request.policy.mode)) {
      reasons.push(`mode ${request.policy.mode} is not supported`);
    }
    if (
      !this.executionCapabilities.modelAuth.includes(request.modelAuth.kind)
    ) {
      reasons.push(`model auth ${request.modelAuth.kind} is not supported`);
    }
    if (
      request.modelAuth.kind === "provider-subscription" &&
      !this.executionCapabilities.subscriptionProviders.includes(
        request.modelAuth.provider,
      )
    ) {
      reasons.push(
        `subscription provider ${request.modelAuth.provider} is not supported`,
      );
    }
    if (request.policy.ttlSeconds > this.executionCapabilities.maxTtlSeconds) {
      reasons.push("requested TTL exceeds the provider maximum");
    }

    return { supported: reasons.length === 0, reasons };
  }

  async start(input: AgentSandboxStartInput): Promise<AgentSandboxSession> {
    const id = `sandbox_${sanitizeId(this.idFactory())}`;
    const startedAt = this.now();
    const session: AgentSandboxSession = {
      id,
      agent: input.manifest.name,
      status: "active",
      provider: this.id,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + 28_800_000).toISOString(),
      metadata: {
        deterministic: true,
        cell: input.cell,
        environment: input.environment,
      },
    };

    this.sessions.set(id, { session, input });
    return structuredClone(session);
  }

  async inspect(sessionId: string): Promise<AgentSandboxSession> {
    return structuredClone(this.requireSession(sessionId).session);
  }

  async suspend(sessionId: string): Promise<void> {
    this.requireSession(sessionId).session.status = "suspended";
  }

  async resume(sessionId: string): Promise<AgentSandboxSession> {
    const session = this.requireSession(sessionId);
    session.session.status = "active";

    return structuredClone(session.session);
  }

  async terminate(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    session.session.status = "terminated";
    session.session.terminatedAt = this.now().toISOString();
  }

  async createAuthToken(sessionId: string) {
    this.requireSession(sessionId);

    return {
      sessionId,
      tokenParts: { Authorization: `Bearer fake-${sessionId}` },
    };
  }

  async prepareWorkspace(
    session: AgentSandboxSession,
    input: { executionId: string; source: AgentExecutionStartInput["source"] },
  ): Promise<AgentExecutionWorkspace> {
    const stored = this.requireSession(session.id);
    const workspace: AgentExecutionWorkspace = {
      id: `workspace_${sanitizeId(input.executionId)}`,
      source: input.source,
      writable: stored.input.manifest.capabilities.filesystem === "read-write",
      metadata: { deterministic: true },
    };
    stored.workspace = workspace;

    return structuredClone(workspace);
  }

  async startExecution(
    session: AgentSandboxSession,
    input: AgentExecutionStartInput,
  ): Promise<AgentExecutionHandle> {
    const stored = this.requireSession(session.id);

    if (!stored.workspace) {
      throw new Error("Workspace must be prepared before execution starts.");
    }

    const handle: AgentExecutionHandle = {
      sessionId: session.id,
      runId: `run_${sanitizeId(this.idFactory())}`,
    };
    const events: AgentExecutionProviderEvent[] = [
      this.event("execution.started", {
        task: input.task,
        mode: input.policy.mode,
        modelAuth: input.modelAuth.kind,
        ...(input.modelAuth.kind === "provider-subscription"
          ? { subscriptionProvider: input.modelAuth.provider }
          : {}),
      }),
      this.event("agent.message", {
        role: "assistant",
        text: `Inspecting ${sourceLabel(input.source)}.`,
      }),
      this.event("command.started", {
        command: "pnpm test",
      }),
    ];
    const approvalAction = stored.input.manifest.requires.humanApproval[0];
    const run: FakeRun = {
      handle,
      session: stored,
      input,
      events,
      done: false,
    };

    if (approvalAction) {
      run.approvalRequestId = `approval_${sanitizeId(this.idFactory())}`;
      events.push(
        this.event("approval.requested", {
          requestId: run.approvalRequestId,
          action: approvalAction,
          reason:
            "The deterministic conformance turn pauses before producing a patch.",
        }),
      );
      stored.session.status = "waiting-for-approval";
    } else {
      this.completeRun(run);
    }

    this.runs.set(handle.runId, run);
    return structuredClone(handle);
  }

  async readEvents(
    handle: AgentExecutionHandle,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<AgentExecutionEventBatch> {
    const run = this.requireRun(handle);
    const start = parseProviderCursor(options.cursor);
    const end =
      options.limit === undefined
        ? run.events.length
        : Math.min(run.events.length, start + Math.max(0, options.limit));

    return {
      events: structuredClone(run.events.slice(start, end)),
      cursor: String(end),
      done: run.done && end >= run.events.length,
    };
  }

  async resolveApproval(
    handle: AgentExecutionHandle,
    decision: AgentExecutionApprovalDecision,
  ): Promise<void> {
    const run = this.requireRun(handle);

    if (
      !run.approvalRequestId ||
      decision.requestId !== run.approvalRequestId
    ) {
      throw new Error(`Unknown approval request '${decision.requestId}'.`);
    }

    run.events.push(
      this.event("approval.resolved", {
        requestId: decision.requestId,
        decision: decision.decision,
        actor: decision.actor,
        reason: decision.reason ?? null,
      }),
    );

    if (decision.decision === "approved") {
      run.session.session.status = "active";
      this.completeRun(run);
      return;
    }

    run.done = true;
    run.session.session.status = "active";
    run.result = emptyResult("cancelled", "Approval was rejected.");
    run.events.push(
      this.event("execution.cancelled", {
        reason: "approval-rejected",
      }),
    );
  }

  async submitInput(
    handle: AgentExecutionHandle,
    input: AgentExecutionInputSubmission,
  ): Promise<void> {
    const run = this.requireRun(handle);
    run.events.push(
      this.event("input.submitted", {
        requestId: input.requestId,
        fields: Object.keys(input.values).sort(),
      }),
    );
  }

  async steer(handle: AgentExecutionHandle, message: string): Promise<void> {
    const run = this.requireRun(handle);
    run.events.push(
      this.event("agent.message", {
        role: "user",
        text: message,
        steering: true,
      }),
    );
  }

  async collectResult(
    handle: AgentExecutionHandle,
  ): Promise<AgentExecutionProviderResult> {
    const run = this.requireRun(handle);

    if (!run.done || !run.result) {
      throw new Error("Execution has not completed.");
    }

    return structuredClone(run.result);
  }

  private completeRun(run: FakeRun): void {
    const patch = {
      id: `artifact_${sanitizeId(this.idFactory())}`,
      name: "execution.patch",
      kind: "patch",
      storage: "session",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      mediaType: "text/x-diff",
    } as const;
    const changedFiles =
      run.input.policy.mode === "read-write" ? ["README.md"] : [];

    run.events.push(
      this.event("command.completed", {
        command: "pnpm test",
        exitCode: 0,
      }),
    );

    if (changedFiles.length > 0) {
      run.events.push(
        this.event("file.changed", { path: "README.md", action: "modified" }),
        this.event("artifact.available", { artifact: patch }),
        this.event("patch.ready", { artifactId: patch.id }),
      );
    }

    run.events.push(
      this.event("usage.updated", {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        estimatedCostUsd: 0.001,
      }),
      this.event("execution.completed", {
        changedFiles,
      }),
    );
    run.done = true;
    run.result = {
      status: "completed",
      summary: "Deterministic execution completed.",
      changedFiles,
      artifacts: changedFiles.length > 0 ? [patch] : [],
      commands: [{ command: "pnpm test", exitCode: 0 }],
      tests: [{ command: "pnpm test", status: "passed" }],
      errors: [],
      evidence: [{ label: "provider", value: this.id }],
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        estimatedCostUsd: 0.001,
        provider: this.id,
      },
      ...(changedFiles.length > 0 ? { patch } : {}),
    };
  }

  private event(
    type: AgentExecutionProviderEvent["type"],
    data: Record<string, unknown>,
  ): AgentExecutionProviderEvent {
    return {
      id: `provider_event_${sanitizeId(this.idFactory())}`,
      type,
      timestamp: this.now().toISOString(),
      data,
    };
  }

  private requireSession(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Unknown fake sandbox '${sessionId}'.`);
    }

    return session;
  }

  private requireRun(handle: AgentExecutionHandle): FakeRun {
    const run = this.runs.get(handle.runId);

    if (!run || run.handle.sessionId !== handle.sessionId) {
      throw new Error(`Unknown fake execution run '${handle.runId}'.`);
    }

    return run;
  }
}

function emptyResult(
  status: "failed" | "cancelled",
  summary: string,
): AgentExecutionProviderResult {
  return {
    status,
    summary,
    changedFiles: [],
    artifacts: [],
    commands: [],
    tests: [],
    errors: [],
    evidence: [],
  };
}

function parseProviderCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }

  const value = Number(cursor);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid fake provider cursor '${cursor}'.`);
  }

  return value;
}

function sourceLabel(source: AgentExecutionStartInput["source"]): string {
  return source.kind === "git"
    ? `${source.repository} at ${source.commit}`
    : `snapshot ${source.snapshotId}`;
}

function sanitizeId(value: string): string {
  return trimBoundaryCharacter(
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
    "-",
  );
}

function trimBoundaryCharacter(value: string, character: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === character) {
    start += 1;
  }
  while (end > start && value[end - 1] === character) {
    end -= 1;
  }

  return value.slice(start, end);
}
