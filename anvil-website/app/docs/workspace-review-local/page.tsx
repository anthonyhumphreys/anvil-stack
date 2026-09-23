import { notFound } from "next/navigation";

import { SiteHeader } from "@/components/site/header";
import { WorkspaceRoute } from "@/components/workspace/workspace-route";
import type { WorkspaceViewModel } from "@/components/workspace/types";

/**
 * Temporary, presentation-only review surface. It deliberately never imports
 * the browser transport: this route is useful for checking responsive layout
 * while Desktop/auth credentials are unavailable, and must not become a
 * production workspace entry point.
 */
export const dynamic = "force-dynamic";

const fixtureWorkspace: WorkspaceViewModel = {
  connection: {
    state: "connected",
    desktopName: "Local UI fixture",
    detail: "Local UI fixture. No Desktop or cloud commands are sent.",
    checkedAt: "2026-09-22T08:45:00.000Z",
  },
  repositories: [
    {
      id: "forge-web",
      name: "forge-web",
      path: "Desktop path withheld in browser",
      branch: "feat/browser-workspace",
      dirty: true,
      authorized: true,
    },
    {
      id: "anvil-cloud",
      name: "anvil-cloud",
      branch: "main",
      authorized: true,
    },
  ],
  sessions: [
    {
      id: "session-browser-workspace",
      repositoryId: "forge-web",
      title: "Browser workspace review",
      state: "running",
      updatedAt: "2026-09-22T08:42:00.000Z",
      summary: "Shape the browser relay without moving execution into the cloud.",
    },
    {
      id: "session-cas-editor",
      repositoryId: "forge-web",
      title: "Revision-safe editor",
      state: "completed",
      updatedAt: "2026-09-21T16:18:00.000Z",
      summary: "Check an expected revision before writing a file.",
    },
  ],
  activeRepositoryId: "forge-web",
  activeSessionId: "session-browser-workspace",
  messages: [
    {
      id: "fixture-message-1",
      role: "user",
      content: "Can the browser workspace stay useful while Desktop remains the executor?",
      createdAt: "2026-09-22T08:37:00.000Z",
    },
    {
      id: "fixture-message-2",
      role: "assistant",
      content:
        "Yes. The browser owns the conversation and review surface; Desktop keeps the repository allowlist, file system, terminal, and preview authority.",
      createdAt: "2026-09-22T08:38:00.000Z",
    },
    {
      id: "fixture-message-3",
      role: "user",
      content: "Keep edits revision-checked and make connection loss visible.",
      createdAt: "2026-09-22T08:41:00.000Z",
    },
    {
      id: "fixture-message-4",
      role: "assistant",
      content:
        "The editor carries the Desktop revision token, and every panel can fall back to an honest unavailable state.",
      createdAt: "2026-09-22T08:42:00.000Z",
    },
  ],
  approvals: [
    {
      id: "fixture-approval-1",
      title: "Run the repository test suite",
      detail: "Desktop requested approval to run pnpm test in forge-web.",
      scope: "forge-web · submit-task",
      state: "pending",
    },
  ],
  files: [
    {
      path: "components/workspace/workspace-shell.tsx",
      status: "modified",
      language: "tsx",
      content: "export function WorkspaceShell() {\n  return <section aria-label=\"Browser workspace\" />;\n}\n",
      revision: "fixture-revision-42",
      editable: true,
    },
    {
      path: "lib/browser-workspace.ts",
      status: "modified",
      language: "typescript",
      content: "export const executionOwner = \"Desktop\";\n",
      revision: "fixture-revision-41",
      editable: true,
    },
    {
      path: "PRODUCT.md",
      status: "unmodified",
      language: "markdown",
      content: "# Browser workspace\n\nDesktop-backed review surface.\n",
      revision: "fixture-revision-40",
      editable: false,
    },
  ],
  changes: [
    {
      path: "components/workspace/workspace-shell.tsx",
      status: "modified",
      additions: 38,
      deletions: 12,
      diff: "@@ -112,8 +112,34 @@\n- return <Placeholder />;\n+ return <WorkspaceShell model={model} actions={actions} />;\n+\n+ // Desktop remains the execution owner.\n+ const revision = file.revision;\n",
    },
    {
      path: "lib/browser-workspace.ts",
      status: "modified",
      additions: 14,
      deletions: 3,
      diff: "@@ -28,3 +28,14 @@\n+ export type WorkspaceCommand =\n+   | \"file.read\"\n+   | \"file.write\"\n+   | \"chat.send\";\n",
    },
  ],
  tests: [
    { id: "fixture-test-1", name: "browser-workspace contract", state: "passed", detail: "18s" },
    { id: "fixture-test-2", name: "revision conflict guard", state: "running", detail: "running" },
    { id: "fixture-test-3", name: "offline state copy", state: "failed", detail: "needs review" },
  ],
  workflows: [
    { id: "fixture-workflow-1", name: "Typecheck website", state: "passed", detail: "pnpm typecheck", updatedAt: "2026-09-22T08:39:00.000Z" },
    { id: "fixture-workflow-2", name: "Build preview", state: "queued", detail: "awaiting local review", updatedAt: "2026-09-22T08:44:00.000Z" },
  ],
  terminal: {
    inputEnabled: false,
    detail: "Fixture output only. Terminal input is disabled for this review route.",
    command: "pnpm typecheck",
    lines: [
      { id: "fixture-terminal-1", text: "$ pnpm typecheck\n", tone: "muted" },
      { id: "fixture-terminal-2", text: "✓ anvil-website: typecheck passed\n", tone: "success" },
      { id: "fixture-terminal-3", text: "✓ browser workspace contract: 18 checks\n", tone: "success" },
      { id: "fixture-terminal-4", text: "exit 0\n", tone: "success" },
    ],
  },
  preview: {
    state: "unavailable",
    detail: "Local UI fixture. No Desktop screenshot was captured.",
  },
  canCreateSession: false,
  canWriteFiles: false,
  canSubmitTasks: false,
  canApproveActions: false,
};

export default function WorkspaceReviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="account" />
      <main id="main-content" className="min-w-0">
        <WorkspaceRoute
          model={fixtureWorkspace}
          draftScope="local-ui-fixture"
          headerSlot={<span className="rounded border border-accent/40 px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-accent">Local UI fixture</span>}
        />
      </main>
    </div>
  );
}
