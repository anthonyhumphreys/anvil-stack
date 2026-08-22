import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_EXECUTION_SCHEMA_VERSION,
  createAgentManifest,
  defineAgent,
  type AgentExecutionSource,
  type AgentExecutionSourceAccess,
  type AgentExecutionWorkspace,
  type AgentExecutionRequest,
  type AgentExecutionApprovalDecision,
  type AgentExecutionEventBatch,
  type AgentExecutionInputSubmission,
  type AgentExecutionProviderResult,
  type AgentExecutionStartInput,
  type AgentSandboxSession,
} from "@anvil-cloud/runtime";
import { describe, expect, it } from "vitest";

import {
  AgentExecutionControlPlane,
  AgentExecutionControlPlaneError,
  createAgentExecutionHttpHandler,
  createAgentExecutionWorkerHttpHandler,
  createHttpAgentExecutionControlPlane,
  createHttpAgentExecutionSourceClient,
  FakeAgentExecutionProvider,
  FileAgentExecutionSnapshotStore,
  InMemoryAgentExecutionStore,
  InMemoryAgentExecutionSnapshotStore,
  JsonFileAgentExecutionStore,
  runAgentExecutionConformance,
  SnapshotStoreAgentExecutionSourceBroker,
  startAgentExecutionNodeHttpServer,
  type AgentExecutionWorkerDriver,
  type AgentExecutionWorkerWorkspaceMaterial,
} from "../src/index.js";

describe("AgentExecutionControlPlane", () => {
  it("passes the deterministic approval, cursor, patch, and teardown conformance loop", async () => {
    const result = await runAgentExecutionConformance();

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "idempotent-create", ok: true }),
        expect.objectContaining({ id: "cursor-resume", ok: true }),
        expect.objectContaining({ id: "patch-result", ok: true }),
        expect.objectContaining({ id: "verified-cleanup", ok: true }),
      ]),
    );
  });

  it("rejects writable work beyond the manifest and credential-bearing source URLs", async () => {
    const request = createRequest({ filesystem: "read", mode: "read-write" });
    request.source = {
      ...request.source,
      kind: "git",
      repository: "https://token@github.com/example/repository.git?secret=yes",
    };
    const plane = createPlane();
    const error = await plane
      .createExecution(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentExecutionControlPlaneError);
    expect(error).toMatchObject({ code: "EXECUTION_INVALID_REQUEST" });
    expect((error as Error).message).toContain("read-write execution");
    expect((error as Error).message).toContain("credential-free HTTPS");
  });

  it("rejects reuse of an idempotency token for a different request", async () => {
    const plane = createPlane();
    const request = createRequest();

    await plane.createExecution(request);
    const error = await plane
      .createExecution({ ...request, task: "Run a different task." })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "EXECUTION_IDEMPOTENCY_CONFLICT",
      details: { executionId: expect.any(String) },
    });
  });

  it("accepts execution-scoped Codex subscription auth without an API key", async () => {
    const request = createRequest({ mode: "read-only" });
    request.modelAuth = {
      kind: "provider-subscription",
      provider: "codex",
      persistence: "sandbox-session",
    };
    const plane = createPlane();
    const created = await plane.createExecution(request);
    const events = await plane.streamEvents(created.id);

    expect(created.request.modelAuth).toEqual({
      kind: "provider-subscription",
      provider: "codex",
      persistence: "sandbox-session",
    });
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "execution.started",
          data: expect.objectContaining({
            modelAuth: "provider-subscription",
            subscriptionProvider: "codex",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(created)).not.toContain("MODEL_API_KEY");
  });

  it("rejects signed snapshot provenance and malformed patch references", async () => {
    const request = createRequest();
    request.source = {
      kind: "snapshot",
      snapshotId: "https://storage.example.test/snapshot",
      sha256: "a".repeat(64),
      sizeBytes: 512,
      baseCommit: "not-a-commit",
      repository: "https://github.com/example/repository.git?token=secret",
      patch: {
        artifactId: "https://storage.example.test/patch",
        sha256: "not-a-digest",
        sizeBytes: 128,
      },
      selection: {
        includesWorkingTreePatch: false,
        excluded: [
          "git-metadata",
          "ignored-files",
          "secret-files",
          "unrelated-untracked-files",
        ],
      },
    };
    const error = await createPlane()
      .createExecution(request)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "EXECUTION_INVALID_REQUEST" });
    expect((error as Error).message).toContain("snapshotId");
    expect((error as Error).message).toContain("credential-free HTTPS");
    expect((error as Error).message).toContain("working-tree patch flag");
    expect((error as Error).message).toContain("artifactId");
  });

  it("replays from durable cursors without duplicating provider events", async () => {
    const plane = createPlane();
    const created = await plane.createExecution(createRequest());
    const first = await plane.streamEvents(created.id);
    const approval = first.events.find(
      (event) => event.type === "approval.requested",
    );

    expect(approval?.data.requestId).toEqual(expect.any(String));
    await plane.resolveApproval(created.id, {
      requestId: String(approval?.data.requestId),
      decision: "approved",
      actor: "reviewer",
    });
    const second = await plane.streamEvents(created.id, first.cursor);
    const replay = await plane.streamEvents(created.id, first.cursor);

    expect(second.events.some((event) => event.type === "patch.ready")).toBe(
      true,
    );
    expect(replay.events).toEqual(second.events);
    expect(new Set(second.events.map((event) => event.id)).size).toBe(
      second.events.length,
    );
  });

  it("enforces cost ceilings and tears down the sandbox when usage crosses them", async () => {
    const plane = createPlane();
    const request = createRequest();
    request.policy.maxCostUsd = 0.0005;
    const created = await plane.createExecution(request);
    const first = await plane.streamEvents(created.id);
    const approval = first.events.find(
      (event) => event.type === "approval.requested",
    );

    await plane.resolveApproval(created.id, {
      requestId: String(approval?.data.requestId),
      decision: "approved",
      actor: "budget-reviewer",
    });

    await expect(plane.getExecution(created.id)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "EXECUTION_COST_BUDGET_EXCEEDED" },
      cleanup: { status: "verified" },
    });
  });

  it("enforces provider-event ceilings and persists the cleanup receipt", async () => {
    const plane = createPlane();
    const request = createRequest();
    request.policy.maxEvents = 2;
    const created = await plane.createExecution(request);

    await plane.streamEvents(created.id);

    await expect(plane.getExecution(created.id)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "EXECUTION_EVENT_BUDGET_EXCEEDED" },
      cleanup: { status: "verified" },
    });
  });

  it("persists leases and events to a JSON store without credential values", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-executions-"));
    const filePath = path.join(rootDir, "executions.json");
    const store = new JsonFileAgentExecutionStore(filePath);
    const plane = new AgentExecutionControlPlane({
      providers: [new FakeAgentExecutionProvider()],
      store,
      idFactory: () => "persisted",
    });

    try {
      const created = await plane.createExecution(createRequest());
      const restored = new AgentExecutionControlPlane({
        providers: [new FakeAgentExecutionProvider()],
        store: new JsonFileAgentExecutionStore(filePath),
      });
      const storedText = await readFile(filePath, "utf8");

      await expect(restored.getExecution(created.id)).resolves.toMatchObject({
        id: created.id,
        status: "waiting-for-approval",
      });
      expect(storedText).not.toContain("ghp_");
      expect(storedText).not.toContain("Bearer ");
      expect(JSON.parse(storedText)).toMatchObject({ schemaVersion: "0.1" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent JSON store mutations without losing executions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-executions-"));
    const store = new JsonFileAgentExecutionStore(
      path.join(rootDir, "executions.json"),
    );
    let id = 0;
    const plane = new AgentExecutionControlPlane({
      providers: [new FakeAgentExecutionProvider()],
      store,
      idFactory: () => `concurrent-${++id}`,
    });
    const firstRequest = createRequest();
    const secondRequest = createRequest();
    secondRequest.clientToken = "second-client-token";

    try {
      const created = await Promise.all([
        plane.createExecution(firstRequest),
        plane.createExecution(secondRequest),
      ]);

      await expect(store.list()).resolves.toEqual(
        expect.arrayContaining(
          created.map((lease) => expect.objectContaining({ id: lease.id })),
        ),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON store record collections", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-executions-"));
    const filePath = path.join(rootDir, "executions.json");

    try {
      await writeFile(
        filePath,
        JSON.stringify({ schemaVersion: "0.1", leases: null, events: [] }),
        "utf8",
      );

      await expect(
        new JsonFileAgentExecutionStore(filePath).list(),
      ).rejects.toThrow(`Invalid execution store at ${filePath}.`);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("stores content-addressed snapshots and consumes worker grants once", async () => {
    const store = new InMemoryAgentExecutionSnapshotStore({
      idFactory: () => "grant-1",
      tokenFactory: () => "one-time-worker-token",
      now: () => new Date("2026-08-10T10:00:00.000Z"),
    });
    const stored = await store.put({
      workspace: "workspace-1",
      baseCommit: "a".repeat(40),
      repository: "https://github.com/example/repository.git",
      archive: Buffer.from("repository archive"),
      workingTreePatch: Buffer.from("diff --git a/README.md b/README.md"),
    });
    const grant = await store.issueGrant({
      workspace: "workspace-1",
      snapshotId: stored.source.snapshotId,
      executionId: "exec-1",
    });
    const download = await store.consumeGrant({
      grantId: grant.id,
      executionId: "exec-1",
      token: grant.token,
    });

    expect(stored.source).toMatchObject({
      kind: "snapshot",
      snapshotId: expect.stringMatching(/^snap_[a-f0-9]{64}$/),
      patch: { artifactId: expect.stringMatching(/^patch_[a-f0-9]{64}$/) },
      selection: { includesWorkingTreePatch: true },
    });
    expect(Buffer.from(download.archive).toString()).toBe("repository archive");
    expect(Buffer.from(download.workingTreePatch ?? []).toString()).toContain(
      "README.md",
    );
    const alternatePatch = await store.put({
      workspace: "workspace-1",
      baseCommit: "a".repeat(40),
      archive: Buffer.from("repository archive"),
      workingTreePatch: Buffer.from(
        "diff --git a/README.md b/README.md\n+alternate",
      ),
    });
    expect(alternatePatch.source.snapshotId).not.toBe(stored.source.snapshotId);
    await expect(
      store.consumeGrant({
        grantId: grant.id,
        executionId: "exec-1",
        token: grant.token,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_SNAPSHOT_GRANT_USED" });
  });

  it("serializes file-backed grant consumption so only one worker can use it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-grants-"));
    const store = new FileAgentExecutionSnapshotStore(rootDir, {
      idFactory: () => "grant-1",
      tokenFactory: () => "one-time-worker-token",
    });

    try {
      const stored = await store.put({
        workspace: "workspace-1",
        baseCommit: "a".repeat(40),
        archive: Buffer.from("repository archive"),
      });
      const grant = await store.issueGrant({
        workspace: "workspace-1",
        snapshotId: stored.source.snapshotId,
        executionId: "exec-1",
      });
      const attempts = await Promise.allSettled([
        store.consumeGrant({
          grantId: grant.id,
          executionId: "exec-1",
          token: grant.token,
        }),
        store.consumeGrant({
          grantId: grant.id,
          executionId: "exec-1",
          token: grant.token,
        }),
      ]);

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "EXECUTION_SNAPSHOT_GRANT_USED",
          }),
        }),
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects file-backed grants with invalid expiry timestamps", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-grants-"));
    const store = new FileAgentExecutionSnapshotStore(rootDir, {
      idFactory: () => "grant-1",
      tokenFactory: () => "one-time-worker-token",
    });

    try {
      const stored = await store.put({
        workspace: "workspace-1",
        baseCommit: "a".repeat(40),
        archive: Buffer.from("repository archive"),
      });
      const grant = await store.issueGrant({
        workspace: "workspace-1",
        snapshotId: stored.source.snapshotId,
        executionId: "exec-1",
      });
      const statePath = path.join(rootDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        grants: Record<string, { expiresAt: string }>;
      };
      state.grants[grant.id]!.expiresAt = "not-a-date";
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      await expect(
        store.consumeGrant({
          grantId: grant.id,
          executionId: "exec-1",
          token: grant.token,
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_SNAPSHOT_GRANT_INVALID" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("passes snapshot access transiently without persisting its bearer token", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-snapshots-"));
    const snapshots = new FileAgentExecutionSnapshotStore(
      path.join(rootDir, "snapshots"),
      {
        idFactory: () => "grant-1",
        tokenFactory: () => "transient-worker-secret",
      },
    );
    const record = await snapshots.put({
      workspace: "workspace-1",
      baseCommit: "a".repeat(40),
      archive: Buffer.from("archive"),
    });
    const provider = new CapturingExecutionProvider();
    const executionStorePath = path.join(rootDir, "executions.json");
    const plane = new AgentExecutionControlPlane({
      providers: [provider],
      store: new JsonFileAgentExecutionStore(executionStorePath),
      sourceBroker: new SnapshotStoreAgentExecutionSourceBroker(
        snapshots,
        "https://control.example.test",
      ),
      idFactory: () => "snapshot-execution",
    });
    const request = createRequest();
    request.source = record.source;

    try {
      await plane.createExecution(request);
      const executionState = await readFile(executionStorePath, "utf8");
      const snapshotState = await readFile(
        path.join(rootDir, "snapshots", "state.json"),
        "utf8",
      );

      expect(provider.sourceAccess).toMatchObject({
        kind: "control-plane-grant",
        token: "transient-worker-secret",
      });
      expect(executionState).not.toContain("transient-worker-secret");
      expect(snapshotState).not.toContain("transient-worker-secret");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reaps expired executions and records verified cleanup", async () => {
    let current = new Date("2026-08-10T10:00:00.000Z");
    const plane = new AgentExecutionControlPlane({
      providers: [new FakeAgentExecutionProvider({ now: () => current })],
      store: new InMemoryAgentExecutionStore(),
      idFactory: () => "expiring",
      now: () => current,
    });
    const created = await plane.createExecution(
      createRequest({ ttlSeconds: 60 }),
    );
    current = new Date("2026-08-10T10:01:01.000Z");
    const reaped = await plane.reapExpired();

    expect(reaped).toHaveLength(1);
    await expect(plane.getExecution(created.id)).resolves.toMatchObject({
      status: "expired",
      cleanup: {
        status: "verified",
        finalSandboxStatus: "terminated",
      },
    });
  });

  it("serves the same execution contract through the hosted HTTP boundary", async () => {
    const plane = createPlane();
    const handler = createAgentExecutionHttpHandler(plane, {
      authenticate: (request) =>
        request.headers?.authorization === "Bearer test-token"
          ? { subject: "user-1", roles: ["operator"] }
          : null,
      authorize: ({ action, execution, executionRequest }) =>
        action !== "reap" &&
        (execution?.request.workspace ?? executionRequest?.workspace) ===
          "workspace-1",
    });
    const client = createHttpAgentExecutionControlPlane(
      "https://control.example.test/",
      {
        headers: async () => ({ authorization: "Bearer test-token" }),
        fetch: async (input, init) => {
          const url = new URL(input);
          const response = await handler({
            method: init?.method ?? "GET",
            path: url.pathname,
            headers: init?.headers,
            query: url.searchParams,
            ...(init?.body === undefined
              ? {}
              : { body: JSON.parse(init.body) as unknown }),
          });

          return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            json: async () => response.body,
          };
        },
      },
    );
    const created = await client.createExecution(createRequest());
    const first = await client.streamEvents(created.id);
    const approval = first.events.find(
      (event) => event.type === "approval.requested",
    );

    await client.resolveApproval(created.id, {
      requestId: String(approval?.data.requestId),
      decision: "approved",
      actor: "http-reviewer",
    });
    const completed = await client.collectResult(created.id);

    expect(await client.listExecutions()).toHaveLength(1);
    expect(completed).toMatchObject({
      status: "completed",
      result: { status: "completed" },
      cleanup: { status: "verified" },
    });
  });

  it("fails closed when hosted execution authentication is absent", async () => {
    const handler = createAgentExecutionHttpHandler(createPlane(), {
      authenticate: () => null,
      authorize: () => true,
    });
    const response = await handler({
      method: "GET",
      path: "/v1/executions",
    });

    expect(response).toMatchObject({
      status: 401,
      body: {
        error: { code: "EXECUTION_AUTHENTICATION_REQUIRED" },
      },
    });
  });

  it("uploads snapshots through workspace auth and serves one-time worker grants", async () => {
    const snapshots = new InMemoryAgentExecutionSnapshotStore({
      idFactory: () => "http-grant",
      tokenFactory: () => "http-worker-token",
    });
    const handler = createAgentExecutionHttpHandler(
      createPlane(),
      {
        authenticate: (request) =>
          request.headers?.authorization === "Bearer user-token"
            ? { subject: "user-1" }
            : null,
        authorize: ({ workspace }) => workspace === "workspace-1",
      },
      { snapshots },
    );
    const upload = await handler({
      method: "POST",
      path: "/v1/source-snapshots",
      headers: { authorization: "Bearer user-token" },
      body: {
        workspace: "workspace-1",
        baseCommit: "a".repeat(40),
        archiveBase64: Buffer.from("archive").toString("base64"),
      },
    });
    const source = upload.body.snapshot as Extract<
      AgentExecutionSource,
      { kind: "snapshot" }
    >;
    const grant = await snapshots.issueGrant({
      workspace: "workspace-1",
      snapshotId: source.snapshotId,
      executionId: "exec-http",
    });
    const download = await handler({
      method: "GET",
      path: `/v1/source-grants/${grant.id}`,
      headers: {
        authorization: `Bearer ${grant.token}`,
        "x-anvil-execution-id": "exec-http",
      },
    });
    const replay = await handler({
      method: "GET",
      path: `/v1/source-grants/${grant.id}`,
      headers: {
        authorization: `Bearer ${grant.token}`,
        "x-anvil-execution-id": "exec-http",
      },
    });

    expect(upload.status).toBe(200);
    expect(download).toMatchObject({
      status: 200,
      body: { archiveBase64: Buffer.from("archive").toString("base64") },
    });
    expect(replay).toMatchObject({
      status: 409,
      body: { error: { code: "EXECUTION_SNAPSHOT_GRANT_USED" } },
    });
  });

  it("runs the authenticated worker protocol and verifies snapshot bytes", async () => {
    const snapshots = new InMemoryAgentExecutionSnapshotStore({
      idFactory: () => "worker-grant",
      tokenFactory: () => "worker-source-token-with-enough-entropy",
    });
    const record = await snapshots.put({
      workspace: "workspace-1",
      baseCommit: "a".repeat(40),
      archive: Buffer.from("worker archive"),
    });
    const access = await new SnapshotStoreAgentExecutionSourceBroker(
      snapshots,
      "https://control.example.test",
    ).prepareAccess({
      executionId: "exec-worker",
      workspace: "workspace-1",
      source: record.source,
      ttlSeconds: 300,
    });
    const sourceHandler = createAgentExecutionHttpHandler(
      createPlane(),
      { authenticate: () => null, authorize: () => false },
      { snapshots },
    );
    const driver = new CapturingWorkerDriver();
    const worker = createAgentExecutionWorkerHttpHandler(
      driver,
      {
        authenticate: (request) =>
          request.headers?.authorization === "Bearer microvm-token",
      },
      {
        fetch: async (input, init) => {
          const url = new URL(input);
          const response = await sourceHandler({
            method: init?.method ?? "GET",
            path: url.pathname,
            headers: init?.headers,
          });

          return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            json: async () => response.body,
          };
        },
      },
    );
    const invalidAccessResponse = await worker({
      method: "POST",
      path: "/_anvil/execution/workspace",
      headers: { authorization: "Bearer microvm-token" },
      body: {
        executionId: "exec-worker",
        source: record.source,
        access: { ...access, expiresAt: "not-a-date" },
      },
    });
    const workspaceResponse = await worker({
      method: "POST",
      path: "/_anvil/execution/workspace",
      headers: { authorization: "Bearer microvm-token" },
      body: {
        executionId: "exec-worker",
        source: record.source,
        access,
      },
    });
    const request = createRequest({ mode: "read-only" });
    request.source = record.source;
    const started = await worker({
      method: "POST",
      path: "/_anvil/execution/runs",
      headers: { authorization: "Bearer microvm-token" },
      body: {
        executionId: "exec-worker",
        task: request.task,
        source: request.source,
        policy: request.policy,
        modelAuth: request.modelAuth,
      },
    });
    const events = await worker({
      method: "GET",
      path: "/_anvil/execution/runs/run-worker/events",
      headers: { authorization: "Bearer microvm-token" },
      query: new URLSearchParams({ cursor: "0", limit: "10" }),
    });
    const result = await worker({
      method: "GET",
      path: "/_anvil/execution/runs/run-worker/result",
      headers: { authorization: "Bearer microvm-token" },
    });
    const unauthenticated = await worker({
      method: "GET",
      path: "/_anvil/execution/runs/run-worker/result",
    });

    expect(workspaceResponse).toMatchObject({
      status: 200,
      body: { workspace: { id: "worker-workspace", writable: false } },
    });
    expect(invalidAccessResponse).toMatchObject({
      status: 400,
      body: { error: { code: "EXECUTION_WORKER_SOURCE_INVALID" } },
    });
    expect(Buffer.from(driver.material?.archive ?? []).toString()).toBe(
      "worker archive",
    );
    expect(JSON.stringify(driver.material)).not.toContain(access?.token);
    expect(started).toMatchObject({
      status: 200,
      body: { runId: "run-worker" },
    });
    expect(events).toMatchObject({
      status: 200,
      body: { events: [expect.objectContaining({ type: "agent.message" })] },
    });
    expect(result).toMatchObject({
      status: 200,
      body: { result: { status: "completed" } },
    });
    expect(unauthenticated).toMatchObject({
      status: 401,
      body: {
        error: { code: "EXECUTION_WORKER_AUTHENTICATION_REQUIRED" },
      },
    });
  });

  it("serves authenticated execution and snapshot clients over Node HTTP", async () => {
    const snapshots = new InMemoryAgentExecutionSnapshotStore();
    const handler = createAgentExecutionHttpHandler(
      createPlane(),
      {
        authenticate: (request) =>
          request.headers?.authorization === "Bearer node-token"
            ? { subject: "local-operator" }
            : null,
        authorize: ({ execution, executionRequest, workspace }) =>
          (execution?.request.workspace ??
            executionRequest?.workspace ??
            workspace) === "workspace-1",
      },
      { snapshots },
    );
    const server = await startAgentExecutionNodeHttpServer({
      handler,
      port: 0,
      authenticateHeaders: (request) =>
        request.headers?.authorization === "Bearer node-token",
    });

    try {
      const options = {
        headers: { authorization: "Bearer node-token" },
      };
      const unauthenticated = await fetch(`${server.url}/v1/executions`, {
        method: "POST",
        body: "{",
      });
      const executions = createHttpAgentExecutionControlPlane(
        server.url,
        options,
      );
      const sources = createHttpAgentExecutionSourceClient(server.url, options);
      const source = await sources.uploadSnapshot({
        workspace: "workspace-1",
        baseCommit: "a".repeat(40),
        archive: Buffer.from("node http archive"),
      });
      const request = createRequest({ mode: "read-only" });
      request.source = source;
      const created = await executions.createExecution(request);

      expect(unauthenticated.status).toBe(401);
      expect(source.snapshotId).toMatch(/^snap_[a-f0-9]{64}$/);
      expect(await executions.listExecutions()).toEqual([
        expect.objectContaining({ id: created.id }),
      ]);
    } finally {
      await server.close();
    }
  });
});

class CapturingExecutionProvider extends FakeAgentExecutionProvider {
  sourceAccess?: AgentExecutionSourceAccess;

  override async prepareWorkspace(
    session: AgentSandboxSession,
    input: {
      executionId: string;
      source: AgentExecutionSource;
      access?: AgentExecutionSourceAccess;
    },
  ): Promise<AgentExecutionWorkspace> {
    this.sourceAccess = input.access;
    return super.prepareWorkspace(session, input);
  }
}

class CapturingWorkerDriver implements AgentExecutionWorkerDriver {
  material?: AgentExecutionWorkerWorkspaceMaterial;

  async prepareWorkspace(
    input: AgentExecutionWorkerWorkspaceMaterial,
  ): Promise<AgentExecutionWorkspace> {
    this.material = structuredClone(input);

    return {
      id: "worker-workspace",
      source: input.source,
      writable: false,
      metadata: { verifiedSource: true },
    };
  }

  async startExecution(
    _input: AgentExecutionStartInput,
  ): Promise<{ runId: string }> {
    return { runId: "run-worker" };
  }

  async readEvents(): Promise<AgentExecutionEventBatch> {
    return {
      events: [
        {
          id: "worker-event-1",
          type: "agent.message",
          data: { role: "assistant", text: "Repository inspected." },
        },
      ],
      cursor: "1",
      done: true,
    };
  }

  async resolveApproval(
    _runId: string,
    _decision: AgentExecutionApprovalDecision,
  ): Promise<void> {}

  async submitInput(
    _runId: string,
    _input: AgentExecutionInputSubmission,
  ): Promise<void> {}

  async steer(_runId: string, _message: string): Promise<void> {}

  async collectResult(): Promise<AgentExecutionProviderResult> {
    return {
      status: "completed",
      summary: "Repository inspected.",
      changedFiles: [],
      artifacts: [],
      commands: [],
      tests: [],
      errors: [],
      evidence: [{ label: "source", value: "verified" }],
    };
  }
}

function createPlane(): AgentExecutionControlPlane {
  let id = 0;
  const idFactory = () => String(++id);

  return new AgentExecutionControlPlane({
    providers: [new FakeAgentExecutionProvider({ idFactory })],
    store: new InMemoryAgentExecutionStore(),
    idFactory,
  });
}

function createRequest(
  options: {
    filesystem?: "read" | "read-write";
    mode?: "read-only" | "read-write";
    ttlSeconds?: number;
  } = {},
): AgentExecutionRequest {
  const agent = createAgentManifest(
    defineAgent({
      name: "coder",
      model: { provider: "control-plane", model: "configured" },
      capabilities: {
        filesystem: options.filesystem ?? "read-write",
        network: { allow: ["github.com"] },
        git: ["read"],
      },
      approvals: { requiredFor: ["git.applyPatch"] },
      runtime: { sandbox: "required" },
    }),
  );

  return {
    schemaVersion: AGENT_EXECUTION_SCHEMA_VERSION,
    clientToken: "client-token",
    workspace: "workspace-1",
    cell: "notes",
    environment: "test",
    task: "Inspect and patch the repository.",
    agent,
    source: {
      kind: "git",
      repository: "https://github.com/example/repository.git",
      commit: "a".repeat(40),
      branch: "main",
      selection: {
        includesWorkingTreePatch: false,
        excluded: [
          "git-metadata",
          "ignored-files",
          "secret-files",
          "unrelated-untracked-files",
        ],
      },
    },
    providerPreference: { kind: "auto" },
    policy: {
      mode: options.mode ?? "read-write",
      ttlSeconds: options.ttlSeconds ?? 3_600,
      network: agent.capabilities.network,
      requireApprovalForExternalActions: true,
    },
    modelAuth: {
      kind: "control-plane",
      credential: "MODEL_API_KEY",
    },
  };
}
