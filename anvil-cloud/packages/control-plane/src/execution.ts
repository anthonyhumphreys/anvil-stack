import { randomUUID } from "node:crypto";

import {
  AGENT_EXECUTION_SCHEMA_VERSION,
  type AgentExecutionApprovalDecision,
  type AgentExecutionEvent,
  type AgentExecutionEventBatch,
  type AgentExecutionHandle,
  type AgentExecutionInputSubmission,
  type AgentExecutionProvider,
  type AgentExecutionProviderEvent,
  type AgentExecutionProviderResult,
  type AgentExecutionRequest,
  type AgentExecutionSourceSelection,
  type AgentExecutionStatus,
  type AgentExecutionWorkspace,
  type AgentSandboxSession,
} from "@anvil-cloud/runtime";

import type { AgentExecutionStore } from "./execution-store.js";

export type AgentExecutionCleanupReceipt = {
  executionId: string;
  sandboxId: string;
  provider: string;
  requestedAt: string;
  completedAt?: string;
  status: "requested" | "verified" | "failed";
  finalSandboxStatus?: AgentSandboxSession["status"];
  error?: { code: string; message: string };
};

export type AgentExecutionLease = {
  schemaVersion: "0.1";
  id: string;
  status: AgentExecutionStatus;
  provider: string;
  request: AgentExecutionRequest;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sandbox?: AgentSandboxSession;
  workspace?: AgentExecutionWorkspace;
  handle?: AgentExecutionHandle;
  providerCursor?: string;
  seenProviderEventIds: string[];
  lastEventSequence: number;
  result?: AgentExecutionProviderResult;
  cleanup?: AgentExecutionCleanupReceipt;
  failure?: { code: string; message: string };
};

export type AgentExecutionCursorBatch = {
  executionId: string;
  events: AgentExecutionEvent[];
  cursor: string;
  done: boolean;
};

export type AgentExecutionControlPlaneOptions = {
  providers: AgentExecutionProvider[];
  store: AgentExecutionStore;
  idFactory?: () => string;
  now?: () => Date;
};

export interface AgentExecutionControlPlaneApi {
  createExecution(request: AgentExecutionRequest): Promise<AgentExecutionLease>;
  getExecution(executionId: string): Promise<AgentExecutionLease>;
  listExecutions(): Promise<AgentExecutionLease[]>;
  streamEvents(
    executionId: string,
    cursor?: string,
    limit?: number,
  ): Promise<AgentExecutionCursorBatch>;
  resolveApproval(
    executionId: string,
    decision: AgentExecutionApprovalDecision,
  ): Promise<AgentExecutionLease>;
  submitInput(
    executionId: string,
    input: AgentExecutionInputSubmission,
  ): Promise<AgentExecutionLease>;
  steer(executionId: string, message: string): Promise<AgentExecutionLease>;
  suspend(executionId: string): Promise<AgentExecutionLease>;
  resume(executionId: string): Promise<AgentExecutionLease>;
  collectResult(executionId: string): Promise<AgentExecutionLease>;
  terminate(executionId: string): Promise<AgentExecutionLease>;
  reapExpired(): Promise<AgentExecutionLease[]>;
}

export class AgentExecutionControlPlaneError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_INVALID_REQUEST"
      | "EXECUTION_IDEMPOTENCY_CONFLICT"
      | "EXECUTION_NOT_FOUND"
      | "EXECUTION_PROVIDER_NOT_FOUND"
      | "EXECUTION_PROVIDER_UNSUPPORTED"
      | "EXECUTION_INVALID_CURSOR"
      | "EXECUTION_INVALID_STATE"
      | "EXECUTION_START_FAILED",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentExecutionControlPlaneError";
  }
}

export class AgentExecutionControlPlane implements AgentExecutionControlPlaneApi {
  private readonly providers: Map<string, AgentExecutionProvider>;
  private readonly store: AgentExecutionStore;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: AgentExecutionControlPlaneOptions) {
    this.providers = new Map(
      options.providers.map((provider) => [provider.id, provider]),
    );
    this.store = options.store;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async createExecution(
    request: AgentExecutionRequest,
  ): Promise<AgentExecutionLease> {
    validateExecutionRequest(request);
    const existing = await this.store.findByClientToken(request.clientToken);

    if (existing) {
      if (canonicalJson(existing.request) !== canonicalJson(request)) {
        throw new AgentExecutionControlPlaneError(
          "EXECUTION_IDEMPOTENCY_CONFLICT",
          `Client token '${request.clientToken}' is already bound to a different execution request.`,
          { executionId: existing.id },
        );
      }

      return existing;
    }

    const provider = this.selectProvider(request);
    const createdAt = this.now().toISOString();
    const lease: AgentExecutionLease = {
      schemaVersion: "0.1",
      id: `exec_${sanitizeId(this.idFactory())}`,
      status: "starting",
      provider: provider.id,
      request,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(
        new Date(createdAt).getTime() + request.policy.ttlSeconds * 1_000,
      ).toISOString(),
      seenProviderEventIds: [],
      lastEventSequence: 0,
    };

    await this.store.put(lease);
    await this.appendEvents(lease, [
      {
        id: `${lease.id}:created`,
        type: "execution.created",
        timestamp: createdAt,
        data: {
          provider: provider.id,
          mode: request.policy.mode,
          expiresAt: lease.expiresAt,
        },
      },
    ]);

    try {
      lease.sandbox = await provider.start({
        manifest: request.agent,
        cell: request.cell,
        environment: request.environment,
        workspace: { snapshot: sourceIdentity(request) },
        credentialBroker: request.agent.credentialBroker,
        clientToken: lease.id,
      });
      await this.appendEvents(lease, [
        {
          id: `${lease.id}:sandbox-started`,
          type: "sandbox.started",
          data: {
            sandboxId: lease.sandbox.id,
            provider: lease.sandbox.provider,
            expiresAt: lease.sandbox.expiresAt ?? lease.expiresAt,
          },
        },
      ]);
      lease.workspace = await provider.prepareWorkspace(lease.sandbox, {
        executionId: lease.id,
        source: request.source,
      });
      lease.handle = await provider.startExecution(lease.sandbox, {
        executionId: lease.id,
        task: request.task,
        source: request.source,
        policy: request.policy,
        modelAuth: request.modelAuth,
      });
      lease.status = "running";
      lease.updatedAt = this.now().toISOString();
      await this.store.put(lease);
      await this.pullProviderEvents(lease);

      return this.getExecution(lease.id);
    } catch (error) {
      const failure = {
        code: errorCode(error, "EXECUTION_START_FAILED"),
        message: errorMessage(error),
      };
      lease.status = "failed";
      lease.failure = failure;
      lease.updatedAt = this.now().toISOString();

      if (lease.sandbox) {
        lease.cleanup = await this.cleanup(provider, lease);
      }

      await this.appendEvents(lease, [
        {
          id: `${lease.id}:start-failed`,
          type: "execution.failed",
          data: failure,
        },
      ]);
      await this.store.put(lease);

      throw new AgentExecutionControlPlaneError(
        "EXECUTION_START_FAILED",
        `Execution ${lease.id} could not start: ${failure.message}`,
        { executionId: lease.id, provider: provider.id, cause: failure },
      );
    }
  }

  async getExecution(executionId: string): Promise<AgentExecutionLease> {
    const lease = await this.store.get(executionId);

    if (!lease) {
      throw new AgentExecutionControlPlaneError(
        "EXECUTION_NOT_FOUND",
        `Execution '${executionId}' was not found.`,
        { executionId },
      );
    }

    return lease;
  }

  async listExecutions(): Promise<AgentExecutionLease[]> {
    return this.store.list();
  }

  async streamEvents(
    executionId: string,
    cursor?: string,
    limit?: number,
  ): Promise<AgentExecutionCursorBatch> {
    const afterSequence = parseCursor(cursor);
    const lease = await this.getExecution(executionId);

    if (lease.handle && !isTerminal(lease.status)) {
      await this.pullProviderEvents(lease, limit);
    }

    const current = await this.getExecution(executionId);
    let events = await this.store.events(executionId, afterSequence);

    if (limit !== undefined && limit >= 0) {
      events = events.slice(0, limit);
    }

    return {
      executionId,
      events,
      cursor: events.at(-1)?.cursor ?? String(afterSequence),
      done: isTerminal(current.status),
    };
  }

  async resolveApproval(
    executionId: string,
    decision: AgentExecutionApprovalDecision,
  ): Promise<AgentExecutionLease> {
    const lease = await this.getRunnable(executionId);
    await this.providerFor(lease).resolveApproval(lease.handle!, decision);
    await this.pullProviderEvents(lease);

    return this.getExecution(executionId);
  }

  async submitInput(
    executionId: string,
    input: AgentExecutionInputSubmission,
  ): Promise<AgentExecutionLease> {
    const lease = await this.getRunnable(executionId);
    await this.providerFor(lease).submitInput(lease.handle!, input);
    await this.pullProviderEvents(lease);

    return this.getExecution(executionId);
  }

  async steer(
    executionId: string,
    message: string,
  ): Promise<AgentExecutionLease> {
    if (message.trim().length === 0) {
      throw new AgentExecutionControlPlaneError(
        "EXECUTION_INVALID_REQUEST",
        "Steering messages must not be empty.",
      );
    }

    const lease = await this.getRunnable(executionId);
    await this.providerFor(lease).steer(lease.handle!, message);
    await this.pullProviderEvents(lease);

    return this.getExecution(executionId);
  }

  async suspend(executionId: string): Promise<AgentExecutionLease> {
    const lease = await this.getRunnable(executionId);
    await this.providerFor(lease).suspend(lease.sandbox!.id);
    lease.status = "suspended";
    lease.updatedAt = this.now().toISOString();
    await this.appendEvents(lease, [
      {
        id: `${lease.id}:suspended:${lease.lastEventSequence + 1}`,
        type: "sandbox.suspended",
        data: { sandboxId: lease.sandbox!.id },
      },
    ]);
    await this.store.put(lease);

    return this.getExecution(executionId);
  }

  async resume(executionId: string): Promise<AgentExecutionLease> {
    const lease = await this.getExecution(executionId);

    if (!lease.sandbox || lease.status !== "suspended") {
      throw invalidState(lease, "Only suspended executions can resume.");
    }

    lease.sandbox = await this.providerFor(lease).resume(lease.sandbox.id);
    lease.status = "running";
    lease.updatedAt = this.now().toISOString();
    await this.appendEvents(lease, [
      {
        id: `${lease.id}:resumed:${lease.lastEventSequence + 1}`,
        type: "sandbox.resumed",
        data: { sandboxId: lease.sandbox.id },
      },
    ]);
    await this.store.put(lease);
    await this.pullProviderEvents(lease);

    return this.getExecution(executionId);
  }

  async collectResult(executionId: string): Promise<AgentExecutionLease> {
    const lease = await this.getExecution(executionId);

    if (lease.result && lease.cleanup) {
      return lease;
    }
    if (lease.failure && lease.cleanup) {
      return lease;
    }

    if (!lease.handle || !lease.sandbox) {
      throw invalidState(lease, "Execution has no active provider handle.");
    }

    await this.pullProviderEvents(lease);
    lease.result = await this.providerFor(lease).collectResult(lease.handle);
    lease.status = lease.result.status;
    lease.cleanup = await this.cleanup(this.providerFor(lease), lease);
    lease.updatedAt = this.now().toISOString();
    await this.appendEvents(lease, [
      {
        id: `${lease.id}:cleanup`,
        type: "cleanup.completed",
        data: lease.cleanup,
      },
    ]);
    await this.store.put(lease);

    return this.getExecution(executionId);
  }

  async terminate(executionId: string): Promise<AgentExecutionLease> {
    const lease = await this.getExecution(executionId);

    if (!lease.sandbox || lease.cleanup) {
      return lease;
    }

    lease.cleanup = await this.cleanup(this.providerFor(lease), lease);
    if (!isTerminal(lease.status)) {
      lease.status = "cancelled";
    }
    lease.updatedAt = this.now().toISOString();
    await this.appendEvents(lease, [
      {
        id: `${lease.id}:terminated`,
        type: "sandbox.terminated",
        data: lease.cleanup,
      },
    ]);
    await this.store.put(lease);

    return this.getExecution(executionId);
  }

  async reapExpired(): Promise<AgentExecutionLease[]> {
    const now = this.now().getTime();
    const expired = (await this.store.list()).filter(
      (lease) =>
        !isTerminal(lease.status) && new Date(lease.expiresAt).getTime() <= now,
    );
    const reaped: AgentExecutionLease[] = [];

    for (const lease of expired) {
      const terminated = await this.terminate(lease.id);
      terminated.status = "expired";
      terminated.updatedAt = this.now().toISOString();
      await this.store.put(terminated);
      reaped.push(terminated);
    }

    return reaped;
  }

  private selectProvider(
    request: AgentExecutionRequest,
  ): AgentExecutionProvider {
    const candidates =
      request.providerPreference.kind === "provider"
        ? [this.providers.get(request.providerPreference.provider)].filter(
            (provider): provider is AgentExecutionProvider =>
              provider !== undefined,
          )
        : [...this.providers.values()];

    if (candidates.length === 0) {
      throw new AgentExecutionControlPlaneError(
        "EXECUTION_PROVIDER_NOT_FOUND",
        request.providerPreference.kind === "provider"
          ? `Execution provider '${request.providerPreference.provider}' is not registered.`
          : "No execution providers are registered.",
      );
    }

    for (const provider of candidates) {
      const support = provider.supports(request);

      if (support.supported) {
        return provider;
      }
    }

    throw new AgentExecutionControlPlaneError(
      "EXECUTION_PROVIDER_UNSUPPORTED",
      "No selected execution provider supports this request.",
      {
        providers: candidates.map((provider) => ({
          provider: provider.id,
          reasons: provider.supports(request).reasons,
        })),
      },
    );
  }

  private async getRunnable(executionId: string): Promise<AgentExecutionLease> {
    const lease = await this.getExecution(executionId);

    if (!lease.handle || !lease.sandbox || isTerminal(lease.status)) {
      throw invalidState(lease, "Execution is not active.");
    }

    return lease;
  }

  private providerFor(lease: AgentExecutionLease): AgentExecutionProvider {
    const provider = this.providers.get(lease.provider);

    if (!provider) {
      throw new AgentExecutionControlPlaneError(
        "EXECUTION_PROVIDER_NOT_FOUND",
        `Execution provider '${lease.provider}' is not registered.`,
        { executionId: lease.id },
      );
    }

    return provider;
  }

  private async pullProviderEvents(
    lease: AgentExecutionLease,
    limit?: number,
  ): Promise<AgentExecutionEventBatch | null> {
    if (!lease.handle) {
      return null;
    }

    const maxEvents = lease.request.policy.maxEvents;
    const remainingEvents =
      maxEvents === undefined
        ? undefined
        : Math.max(0, maxEvents - lease.seenProviderEventIds.length);

    if (remainingEvents === 0) {
      await this.failForPolicy(
        lease,
        "EXECUTION_EVENT_BUDGET_EXCEEDED",
        `Execution exceeded its ${maxEvents} provider-event limit.`,
      );
      await this.store.put(lease);

      return { events: [], done: true };
    }

    const providerLimit =
      remainingEvents === undefined
        ? limit
        : limit === undefined
          ? remainingEvents
          : Math.min(limit, remainingEvents);
    const batch = await this.providerFor(lease).readEvents(lease.handle, {
      ...(lease.providerCursor === undefined
        ? {}
        : { cursor: lease.providerCursor }),
      ...(providerLimit === undefined ? {} : { limit: providerLimit }),
    });
    let unseen = batch.events.filter(
      (event) => !lease.seenProviderEventIds.includes(event.id),
    );
    const eventBudgetExceeded =
      remainingEvents !== undefined && unseen.length > remainingEvents;

    if (remainingEvents !== undefined) {
      unseen = unseen.slice(0, remainingEvents);
    }

    if (unseen.length > 0) {
      await this.appendEvents(lease, unseen);
      lease.seenProviderEventIds.push(...unseen.map((event) => event.id));
      updateStatusFromEvents(lease, unseen);
    }

    if (batch.cursor !== undefined) {
      lease.providerCursor = batch.cursor;
    }
    lease.updatedAt = this.now().toISOString();

    const estimatedCostUsd = latestEstimatedCost(unseen);
    const maxCostUsd = lease.request.policy.maxCostUsd;

    if (eventBudgetExceeded) {
      await this.failForPolicy(
        lease,
        "EXECUTION_EVENT_BUDGET_EXCEEDED",
        `Execution exceeded its ${maxEvents} provider-event limit.`,
        true,
      );
    } else if (
      maxCostUsd !== undefined &&
      estimatedCostUsd !== undefined &&
      estimatedCostUsd > maxCostUsd
    ) {
      await this.failForPolicy(
        lease,
        "EXECUTION_COST_BUDGET_EXCEEDED",
        `Execution estimated cost ${estimatedCostUsd} USD exceeded its ${maxCostUsd} USD limit.`,
        true,
      );
    }

    await this.store.put(lease);

    return batch;
  }

  private async failForPolicy(
    lease: AgentExecutionLease,
    code: string,
    message: string,
    force = false,
  ): Promise<void> {
    if (isTerminal(lease.status) && !force) {
      return;
    }

    lease.status = "failed";
    lease.failure = { code, message };
    lease.updatedAt = this.now().toISOString();
    if (lease.sandbox && !lease.cleanup) {
      lease.cleanup = await this.cleanup(this.providerFor(lease), lease);
    }
    await this.appendEvents(lease, [
      {
        id: `${lease.id}:policy-failed:${lease.lastEventSequence + 1}`,
        type: "execution.failed",
        data: { code, message },
      },
    ]);
  }

  private async appendEvents(
    lease: AgentExecutionLease,
    events: AgentExecutionProviderEvent[],
  ): Promise<void> {
    const normalized = events.map((event) => {
      const sequence = ++lease.lastEventSequence;

      return {
        ...event,
        executionId: lease.id,
        sequence,
        cursor: String(sequence),
        timestamp: event.timestamp ?? this.now().toISOString(),
      } satisfies AgentExecutionEvent;
    });

    await this.store.appendEvents(lease.id, normalized);
  }

  private async cleanup(
    provider: AgentExecutionProvider,
    lease: AgentExecutionLease,
  ): Promise<AgentExecutionCleanupReceipt> {
    const requestedAt = this.now().toISOString();
    const receipt: AgentExecutionCleanupReceipt = {
      executionId: lease.id,
      sandboxId: lease.sandbox!.id,
      provider: provider.id,
      requestedAt,
      status: "requested",
    };

    try {
      await provider.terminate(lease.sandbox!.id);
      const inspected = await provider.inspect(lease.sandbox!.id);
      receipt.completedAt = this.now().toISOString();
      receipt.finalSandboxStatus = inspected.status;
      receipt.status =
        inspected.status === "terminated" || inspected.status === "expired"
          ? "verified"
          : "requested";
    } catch (error) {
      receipt.status = "failed";
      receipt.error = {
        code: errorCode(error, "EXECUTION_CLEANUP_FAILED"),
        message: errorMessage(error),
      };
    }

    return receipt;
  }
}

function validateExecutionRequest(request: AgentExecutionRequest): void {
  const value = request as unknown;

  if (
    !isObject(value) ||
    !isObject(value.policy) ||
    !isObject(value.agent) ||
    !isObject(value.agent.capabilities) ||
    !isObject(value.source) ||
    !isObject(value.source.selection) ||
    !Array.isArray(value.source.selection.excluded) ||
    !isObject(value.providerPreference) ||
    !isObject(value.modelAuth)
  ) {
    throw new AgentExecutionControlPlaneError(
      "EXECUTION_INVALID_REQUEST",
      "Invalid execution request: request, policy, agent, source, source selection, providerPreference, and modelAuth must use the execution schema.",
    );
  }

  const errors: string[] = [];

  if (request.schemaVersion !== AGENT_EXECUTION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${AGENT_EXECUTION_SCHEMA_VERSION}`);
  }
  if (
    typeof request.clientToken !== "string" ||
    request.clientToken.trim().length === 0 ||
    request.clientToken.length > 200
  ) {
    errors.push("clientToken must contain between 1 and 200 characters");
  }
  if (typeof request.cell !== "string" || request.cell.trim().length === 0) {
    errors.push("cell must not be empty");
  }
  if (
    typeof request.environment !== "string" ||
    request.environment.trim().length === 0
  ) {
    errors.push("environment must not be empty");
  }
  if (typeof request.task !== "string" || request.task.trim().length === 0) {
    errors.push("task must not be empty");
  }
  if (
    typeof request.agent.name !== "string" ||
    request.agent.name.trim().length === 0
  ) {
    errors.push("agent manifest name must not be empty");
  }
  if (
    !["none", "read", "read-write"].includes(
      request.agent.capabilities.filesystem,
    )
  ) {
    errors.push("agent manifest filesystem capability is invalid");
  }
  if (
    request.policy.mode !== "read-only" &&
    request.policy.mode !== "read-write"
  ) {
    errors.push("mode must be read-only or read-write");
  }
  if (
    !Number.isSafeInteger(request.policy.ttlSeconds) ||
    request.policy.ttlSeconds < 60 ||
    request.policy.ttlSeconds > 28_800
  ) {
    errors.push("ttlSeconds must be between 60 and 28800");
  }
  if (
    request.policy.maxEvents !== undefined &&
    (!Number.isSafeInteger(request.policy.maxEvents) ||
      request.policy.maxEvents < 1 ||
      request.policy.maxEvents > 100_000)
  ) {
    errors.push("maxEvents must be an integer between 1 and 100000");
  }
  if (
    request.policy.maxCostUsd !== undefined &&
    (!Number.isFinite(request.policy.maxCostUsd) ||
      request.policy.maxCostUsd <= 0)
  ) {
    errors.push("maxCostUsd must be a positive number");
  }
  if (typeof request.policy.requireApprovalForExternalActions !== "boolean") {
    errors.push("requireApprovalForExternalActions must be a boolean");
  }
  if (
    request.policy.mode === "read-write" &&
    request.agent.capabilities.filesystem !== "read-write"
  ) {
    errors.push(
      "read-write execution requires agent filesystem read-write capability",
    );
  }
  const policyNetworkValid = isNetworkPolicy(request.policy.network);
  const manifestNetworkValid = isNetworkPolicy(
    request.agent.capabilities.network,
  );

  if (!policyNetworkValid) {
    errors.push("execution network policy is invalid");
  }
  if (!manifestNetworkValid) {
    errors.push("agent manifest network capability is invalid");
  }
  if (
    policyNetworkValid &&
    manifestNetworkValid &&
    stableNetworkPolicy(request.policy.network) !==
      stableNetworkPolicy(request.agent.capabilities.network)
  ) {
    errors.push("execution network policy must match the agent manifest");
  }
  if (request.modelAuth.kind !== "control-plane") {
    errors.push("modelAuth kind must be control-plane");
  }
  if (
    typeof request.modelAuth.credential !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(request.modelAuth.credential)
  ) {
    errors.push("modelAuth credential must be a control-plane credential name");
  }

  if (
    request.providerPreference.kind !== "auto" &&
    request.providerPreference.kind !== "provider"
  ) {
    errors.push("providerPreference kind must be auto or provider");
  } else if (
    request.providerPreference.kind === "provider" &&
    (typeof request.providerPreference.provider !== "string" ||
      request.providerPreference.provider.trim().length === 0)
  ) {
    errors.push("providerPreference provider must not be empty");
  }

  const exclusions = new Set(request.source.selection.excluded);
  const requiredExclusions: AgentExecutionSourceSelection["excluded"] = [
    "git-metadata",
    "ignored-files",
    "secret-files",
    "unrelated-untracked-files",
  ];
  for (const required of requiredExclusions) {
    if (!exclusions.has(required)) {
      errors.push(`source selection must exclude ${required}`);
    }
  }
  if (
    request.source.selection.excluded.some(
      (entry) => !requiredExclusions.includes(entry),
    )
  ) {
    errors.push("source selection contains an unknown exclusion");
  }

  if (typeof request.source.selection.includesWorkingTreePatch !== "boolean") {
    errors.push("source selection working-tree patch flag must be a boolean");
  }

  if (request.source.kind === "git") {
    if (!isCredentialFreeHttpsUrl(request.source.repository)) {
      errors.push("git source must use a credential-free HTTPS repository URL");
    }

    if (!/^[a-f0-9]{7,64}$/i.test(request.source.commit)) {
      errors.push(
        "git source commit must be an immutable hexadecimal revision",
      );
    }
    if (request.source.selection.includesWorkingTreePatch) {
      errors.push("git source cannot include a working-tree patch");
    }
    if (
      request.source.subdirectory !== undefined &&
      !isSafeRelativePath(request.source.subdirectory)
    ) {
      errors.push("git source subdirectory must be a safe relative path");
    }
  } else if (request.source.kind === "snapshot") {
    if (!isOpaqueId(request.source.snapshotId)) {
      errors.push("snapshotId must be an opaque identifier");
    }
    if (!/^[a-f0-9]{64}$/i.test(request.source.sha256)) {
      errors.push("snapshot sha256 must contain 64 hexadecimal characters");
    }
    if (
      !Number.isSafeInteger(request.source.sizeBytes) ||
      request.source.sizeBytes <= 0
    ) {
      errors.push("snapshot sizeBytes must be a positive integer");
    }
    if (!/^[a-f0-9]{7,64}$/i.test(request.source.baseCommit)) {
      errors.push("snapshot baseCommit must be a hexadecimal revision");
    }
    if (
      request.source.repository !== undefined &&
      !isCredentialFreeHttpsUrl(request.source.repository)
    ) {
      errors.push(
        "snapshot repository must use a credential-free HTTPS repository URL",
      );
    }
    if (
      request.source.selection.includesWorkingTreePatch !==
      (request.source.patch !== undefined)
    ) {
      errors.push(
        "snapshot working-tree patch flag must match the patch reference",
      );
    }
    if (request.source.patch) {
      if (!isOpaqueId(request.source.patch.artifactId)) {
        errors.push("snapshot patch artifactId must be an opaque identifier");
      }
      if (!/^[a-f0-9]{64}$/i.test(request.source.patch.sha256)) {
        errors.push(
          "snapshot patch sha256 must contain 64 hexadecimal characters",
        );
      }
      if (
        !Number.isSafeInteger(request.source.patch.sizeBytes) ||
        request.source.patch.sizeBytes <= 0
      ) {
        errors.push("snapshot patch sizeBytes must be a positive integer");
      }
    }
  } else {
    errors.push("source kind must be git or snapshot");
  }

  if (errors.length > 0) {
    throw new AgentExecutionControlPlaneError(
      "EXECUTION_INVALID_REQUEST",
      `Invalid execution request: ${errors.join("; ")}.`,
      { errors },
    );
  }
}

function updateStatusFromEvents(
  lease: AgentExecutionLease,
  events: AgentExecutionProviderEvent[],
): void {
  for (const event of events) {
    switch (event.type) {
      case "execution.started":
      case "approval.resolved":
      case "input.submitted":
      case "sandbox.resumed":
        lease.status = "running";
        break;
      case "approval.requested":
        lease.status = "waiting-for-approval";
        break;
      case "input.requested":
        lease.status = "waiting-for-input";
        break;
      case "sandbox.suspended":
        lease.status = "suspended";
        break;
      case "execution.completed":
        lease.status = "completed";
        break;
      case "execution.failed":
        lease.status = "failed";
        break;
      case "execution.cancelled":
        lease.status = "cancelled";
        break;
      default:
        break;
    }
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") {
    return 0;
  }

  const value = Number(cursor);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentExecutionControlPlaneError(
      "EXECUTION_INVALID_CURSOR",
      `Execution cursor '${cursor}' is invalid.`,
      { cursor },
    );
  }

  return value;
}

function sourceIdentity(request: AgentExecutionRequest): string {
  return request.source.kind === "snapshot"
    ? request.source.snapshotId
    : `${request.source.repository}#${request.source.commit}`;
}

function sanitizeId(value: string): string {
  return trimBoundaryCharacter(
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
    "-",
  );
}

function isTerminal(status: AgentExecutionStatus): boolean {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

function invalidState(
  lease: AgentExecutionLease,
  message: string,
): AgentExecutionControlPlaneError {
  return new AgentExecutionControlPlaneError(
    "EXECUTION_INVALID_STATE",
    message,
    { executionId: lease.id, status: lease.status },
  );
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestEstimatedCost(
  events: AgentExecutionProviderEvent[],
): number | undefined {
  return events.reduce<number | undefined>((latest, event) => {
    const value = event.data.estimatedCostUsd;

    return event.type === "usage.updated" && typeof value === "number"
      ? value
      : latest;
  }, undefined);
}

function stableNetworkPolicy(
  policy: AgentExecutionRequest["policy"]["network"],
): string {
  if (typeof policy === "string") {
    return policy;
  }

  return JSON.stringify({
    allow: [...(policy.allow ?? [])].sort(),
    deny: [...(policy.deny ?? [])].sort(),
  });
}

function isNetworkPolicy(
  value: unknown,
): value is AgentExecutionRequest["policy"]["network"] {
  if (value === "none" || value === "restricted") {
    return true;
  }
  if (!isObject(value)) {
    return false;
  }

  return [value.allow, value.deny].every(
    (entries) =>
      entries === undefined ||
      (Array.isArray(entries) &&
        entries.every((entry) => typeof entry === "string")),
  );
}

function isCredentialFreeHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isOpaqueId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  );
}

function isSafeRelativePath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    return false;
  }

  return !value.startsWith("/") && !value.split("/").includes("..");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
