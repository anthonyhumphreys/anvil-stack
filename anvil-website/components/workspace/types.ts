import type { ReactNode } from "react";

export type WorkspaceView = "conversation" | "files" | "changes" | "runs" | "terminal" | "preview";

export type WorkspaceConnectionState =
  | "connected"
  | "connecting"
  | "offline"
  | "permission-denied"
  | "unavailable";

export type WorkspaceSessionState = "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface WorkspaceConnection {
  state: WorkspaceConnectionState;
  desktopName?: string;
  detail?: string;
  checkedAt?: string;
}

export interface WorkspaceRepository {
  id: string;
  name: string;
  path?: string;
  branch?: string;
  dirty?: boolean;
  authorized: boolean;
}

export interface WorkspaceSession {
  id: string;
  repositoryId: string;
  title: string;
  state: WorkspaceSessionState;
  updatedAt?: string;
  summary?: string;
}

export interface WorkspaceMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  pending?: boolean;
}

export interface WorkspaceApproval {
  id: string;
  title: string;
  detail: string;
  scope?: string;
  expiresAt?: string;
  state: "pending" | "approved" | "rejected" | "expired";
}

export interface WorkspaceFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unmodified";
  content?: string;
  revision?: string | null;
  language?: string;
  editable?: boolean;
}

export interface WorkspaceChange {
  path: string;
  status: Exclude<WorkspaceFile["status"], "unmodified">;
  additions: number;
  deletions: number;
  diff?: string;
}

export interface WorkspaceTest {
  id: string;
  name: string;
  state: "queued" | "running" | "passed" | "failed" | "cancelled" | "unknown";
  detail?: string;
  durationMs?: number;
}

export interface WorkspaceWorkflow {
  id: string;
  name: string;
  state: "queued" | "running" | "passed" | "failed" | "cancelled" | "unknown";
  detail?: string;
  updatedAt?: string;
}

export interface WorkspaceTerminalLine {
  id: string;
  text: string;
  tone?: "plain" | "muted" | "success" | "warning" | "error";
}

export interface WorkspaceTerminal {
  lines: WorkspaceTerminalLine[];
  command?: string;
  inputEnabled: boolean;
  detail?: string;
}

export interface WorkspacePreview {
  state: "unavailable" | "starting" | "ready" | "stopped" | "error";
  data?: string;
  mimeType?: "image/png";
  capturedAt?: string;
  detail?: string;
}

/**
 * Presentational data for the browser workspace. The browser transport maps
 * its encrypted contract into this view model. It deliberately contains no
 * account keys, grant material, or transport methods.
 */
export interface WorkspaceViewModel {
  connection: WorkspaceConnection;
  repositories: WorkspaceRepository[];
  sessions: WorkspaceSession[];
  activeRepositoryId?: string;
  activeSessionId?: string;
  messages: WorkspaceMessage[];
  approvals: WorkspaceApproval[];
  files: WorkspaceFile[];
  changes: WorkspaceChange[];
  tests: WorkspaceTest[];
  workflows: WorkspaceWorkflow[];
  terminal?: WorkspaceTerminal;
  preview?: WorkspacePreview;
  canCreateSession: boolean;
  canWriteFiles: boolean;
  canSubmitTasks: boolean;
  canApproveActions: boolean;
}

/**
 * User intent callbacks are injected by the transport adapter. Undefined
 * actions stay disabled, which keeps an offline or unconfigured route honest.
 */
export interface WorkspaceActions {
  onSelectRepository?: (repositoryId: string) => void | Promise<void>;
  onSelectSession?: (sessionId: string) => void | Promise<void>;
  onCreateSession?: () => void | Promise<void>;
  onSendMessage?: (content: string) => void | Promise<void>;
  onCancelSession?: () => void | Promise<void>;
  onApproveAction?: (approvalId: string) => void | Promise<void>;
  onRejectAction?: (approvalId: string) => void | Promise<void>;
  onSelectFile?: (path: string) => void | Promise<void>;
  onSaveFile?: (path: string, content: string, expectedRevision?: string | null) => void | Promise<void>;
  onRunTests?: () => void | Promise<void>;
  onRunWorkflow?: (workflowId: string) => void | Promise<void>;
  onCancelWorkflow?: (workflowId: string) => void | Promise<void>;
  onSendTerminalCommand?: (command: string) => void | Promise<void>;
  onStartPreview?: () => void | Promise<void>;
  onRefreshPreview?: () => void | Promise<void>;
}

export interface WorkspaceShellProps {
  model: WorkspaceViewModel;
  actions?: WorkspaceActions;
  /**
   * An opaque, already account/workspace-scoped key supplied by the browser
   * transport. Drafts are never persisted if this is omitted.
   */
  draftScope?: string | null;
  className?: string;
  headerSlot?: ReactNode;
}
