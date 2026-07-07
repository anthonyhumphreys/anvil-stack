import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalApprovalStore } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("LocalApprovalStore", () => {
  it("persists approval requests and decisions with audit events", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-approvals-"));
    tempDirs.push(rootDir);
    const store = new LocalApprovalStore({
      filePath: path.join(rootDir, "approvals.json"),
      idFactory: () => "appr_test",
      now: () => new Date("2026-07-06T12:00:00.000Z"),
    });

    await expect(
      store.requestApproval({
        action: "deploy.preview",
        reason: "Preview deploys need a human check.",
        metadata: {
          agentName: "shipmate",
          sessionId: "sess_1",
        },
      }),
    ).resolves.toEqual({ status: "pending", approvalId: "appr_test" });
    await expect(store.list({ status: "pending" })).resolves.toMatchObject([
      {
        id: "appr_test",
        status: "pending",
        action: "deploy.preview",
        metadata: {
          agentName: "shipmate",
          sessionId: "sess_1",
        },
      },
    ]);

    await expect(
      store.approve("appr_test", {
        approvedBy: "tester",
        reason: "Looks safe.",
      }),
    ).resolves.toMatchObject({
      id: "appr_test",
      status: "approved",
      decidedBy: "tester",
      decisionReason: "Looks safe.",
    });

    const reloaded = new LocalApprovalStore({
      filePath: path.join(rootDir, "approvals.json"),
    });

    await expect(reloaded.audit()).resolves.toMatchObject([
      { type: "approval.requested", approvalId: "appr_test" },
      {
        type: "approval.approved",
        approvalId: "appr_test",
        actor: "tester",
      },
    ]);
  });

  it("records webhook delivery without blocking pending approvals", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-approvals-"));
    tempDirs.push(rootDir);
    const calls: unknown[] = [];
    const store = new LocalApprovalStore({
      filePath: path.join(rootDir, "approvals.json"),
      webhookUrl: "https://hooks.example.test/approvals",
      idFactory: () => "appr_hook",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)) as unknown);

        return new Response("ok", { status: 202 });
      },
    });

    await expect(
      store.requestApproval({ action: "filesystem.write" }),
    ).resolves.toEqual({ status: "pending", approvalId: "appr_hook" });
    expect(calls).toMatchObject([
      {
        type: "approval.requested",
        approval: {
          id: "appr_hook",
          action: "filesystem.write",
        },
      },
    ]);
    await expect(store.audit()).resolves.toMatchObject([
      { type: "approval.requested", approvalId: "appr_hook" },
      { type: "approval.webhook.delivered", approvalId: "appr_hook" },
    ]);
  });
});
