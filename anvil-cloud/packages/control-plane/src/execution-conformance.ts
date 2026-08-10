import {
  AGENT_EXECUTION_SCHEMA_VERSION,
  createAgentManifest,
  defineAgent,
  type AgentExecutionRequest,
} from "@anvil-cloud/runtime";

import { AgentExecutionControlPlane } from "./execution.js";
import { InMemoryAgentExecutionStore } from "./execution-store.js";
import { FakeAgentExecutionProvider } from "./fake-execution-provider.js";

export type AgentExecutionConformanceCheck = {
  id: string;
  ok: boolean;
  message: string;
};

export type AgentExecutionConformanceResult = {
  ok: boolean;
  checks: AgentExecutionConformanceCheck[];
  executionId: string;
};

export async function runAgentExecutionConformance(): Promise<AgentExecutionConformanceResult> {
  let id = 0;
  const idFactory = () => String(++id);
  const now = () =>
    new Date(`2026-08-10T10:00:${String(id).padStart(2, "0")}.000Z`);
  const provider = new FakeAgentExecutionProvider({ idFactory, now });
  const plane = new AgentExecutionControlPlane({
    providers: [provider],
    store: new InMemoryAgentExecutionStore(),
    idFactory,
    now,
  });
  const agent = createAgentManifest(
    defineAgent({
      name: "conformance-coder",
      model: { provider: "control-plane", model: "configured" },
      capabilities: {
        filesystem: "read-write",
        network: { allow: ["github.com"] },
        git: ["read"],
      },
      approvals: { requiredFor: ["git.applyPatch"] },
      runtime: { sandbox: "required", humanApproval: "required" },
    }),
  );
  const request: AgentExecutionRequest = {
    schemaVersion: AGENT_EXECUTION_SCHEMA_VERSION,
    clientToken: "conformance-client-token",
    workspace: "conformance-workspace",
    cell: "conformance",
    environment: "test",
    task: "Inspect the repository, run tests, and produce a deterministic patch.",
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
      mode: "read-write",
      ttlSeconds: 3_600,
      network: agent.capabilities.network,
      maxCostUsd: 1,
      maxEvents: 1_000,
      requireApprovalForExternalActions: true,
    },
    modelAuth: {
      kind: "control-plane",
      credential: "MODEL_API_KEY",
    },
  };
  const created = await plane.createExecution(request);
  const duplicate = await plane.createExecution(request);
  const first = await plane.streamEvents(created.id);
  const approval = first.events.find(
    (event) => event.type === "approval.requested",
  );
  const checks: AgentExecutionConformanceCheck[] = [
    check(
      "idempotent-create",
      duplicate.id === created.id,
      "Client tokens are idempotent.",
    ),
    check(
      "approval-pause",
      created.status === "waiting-for-approval" && approval !== undefined,
      "The deterministic turn pauses for approval.",
    ),
  ];

  if (!approval || typeof approval.data.requestId !== "string") {
    return { ok: false, checks, executionId: created.id };
  }

  const resumedEmpty = await plane.streamEvents(created.id, first.cursor);
  checks.push(
    check(
      "cursor-resume",
      resumedEmpty.events.length === 0,
      "Replaying from the latest cursor does not duplicate events.",
    ),
  );
  await plane.resolveApproval(created.id, {
    requestId: approval.data.requestId,
    decision: "approved",
    actor: "conformance-suite",
    reason: "Exercise the approval continuation contract.",
  });
  const afterApproval = await plane.streamEvents(created.id, first.cursor);
  const collected = await plane.collectResult(created.id);
  checks.push(
    check(
      "approval-resume",
      afterApproval.events.some(
        (event) => event.type === "execution.completed",
      ),
      "Approval resumes the same execution and reaches completion.",
    ),
    check(
      "patch-result",
      collected.result?.patch?.kind === "patch" &&
        collected.result.changedFiles.includes("README.md"),
      "Writable execution returns a patch and changed-file manifest.",
    ),
    check(
      "verified-cleanup",
      collected.cleanup?.status === "verified" &&
        collected.cleanup.finalSandboxStatus === "terminated",
      "Collection proves sandbox teardown.",
    ),
  );

  return {
    ok: checks.every((item) => item.ok),
    checks,
    executionId: created.id,
  };
}

function check(
  id: string,
  ok: boolean,
  message: string,
): AgentExecutionConformanceCheck {
  return { id, ok, message };
}
