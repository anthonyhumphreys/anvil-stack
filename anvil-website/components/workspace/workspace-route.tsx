"use client";

import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import type { WorkspaceActions, WorkspaceShellProps, WorkspaceViewModel } from "@/components/workspace/types";

export const unavailableWorkspace: WorkspaceViewModel = {
  connection: {
    state: "unavailable",
    detail: "No authorized Desktop connection is available for this browser session.",
  },
  repositories: [],
  sessions: [],
  messages: [],
  approvals: [],
  files: [],
  changes: [],
  tests: [],
  workflows: [],
  canCreateSession: false,
  canWriteFiles: false,
  canSubmitTasks: false,
  canApproveActions: false,
};

export interface WorkspaceRouteProps {
  model?: WorkspaceViewModel;
  actions?: WorkspaceActions;
  draftScope?: string | null;
  headerSlot?: WorkspaceShellProps["headerSlot"];
}

/**
 * UI-only entry point. The browser transport injects its decrypted view model
 * and callbacks here. The honest default is unavailable, with every mutating
 * control disabled, so a deployment never looks connected by accident.
 */
export function WorkspaceRoute({ model = unavailableWorkspace, actions, draftScope, headerSlot }: WorkspaceRouteProps) {
  return <WorkspaceShell model={model} actions={actions} draftScope={draftScope} headerSlot={headerSlot} />;
}
