import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_EXECUTION_SCHEMA_VERSION,
  createAgentManifest,
  defineAgent,
  type AgentExecutionRequest,
} from "@anvil-cloud/runtime";
import { describe, expect, it } from "vitest";

import {
  AgentExecutionControlPlane,
  AgentExecutionControlPlaneError,
  createAgentExecutionHttpHandler,
  createHttpAgentExecutionControlPlane,
  FakeAgentExecutionProvider,
  InMemoryAgentExecutionStore,
  JsonFileAgentExecutionStore,
  runAgentExecutionConformance,
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
    const handler = createAgentExecutionHttpHandler(plane);
    const client = createHttpAgentExecutionControlPlane(
      "https://control.example.test/",
      async (input, init) => {
        const url = new URL(input);
        const response = await handler({
          method: init?.method ?? "GET",
          path: url.pathname,
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
});

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
