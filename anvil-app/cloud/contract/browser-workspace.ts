// Browser workspace command relay (browser-workspace/1).
//
// The coordinator only sees routing metadata and opaque AES-GCM envelopes.
// A command is executable only after the approving Desktop enrollment claims
// it and opens it with the DSK from the corresponding dashboard grant.

import type { DashboardScope } from './dashboard';

export const BROWSER_WORKSPACE_PROFILE = 'browser-workspace/1' as const;
/** Optional discovery feature name; sync/1 and mesh/1 remain unchanged. */
export const BROWSER_WORKSPACE_FEATURE = BROWSER_WORKSPACE_PROFILE;

/** Additive Desktop relay methods; these are not part of frozen mesh/1. */
export const BROWSER_WORKSPACE_RPC_CLASS = {
  // Claim is control-plane reservation. The claim handler gates only queued
  // operations that actually start/write work; reads and cancellation remain
  // available during hosted billing restrictions.
  'dashboard.command.claim': 'control',
  'dashboard.command.complete': 'control',
} as const;
export type BrowserWorkspaceRpcOperation = keyof typeof BROWSER_WORKSPACE_RPC_CLASS;

/** The deliberately small browser command vocabulary. */
export const BROWSER_WORKSPACE_OPERATIONS = [
  'workspace.get',
  'repo.list',
  'file.list',
  'file.read',
  'file.write',
  'chat.thread.list',
  'chat.create',
  'chat.history.read',
  'chat.session.start',
  'chat.send',
  'chat.status',
  'chat.cancel',
  'chat.approvals.list',
  'chat.approve',
  'chat.input',
  'git.status',
  'git.diff',
  'workflow.list',
  'workflow.get',
  'workflow.start',
  'workflow.cancel',
  'terminal.create',
  'terminal.read',
  'terminal.write',
  'terminal.resize',
  'terminal.close',
  'preview.screenshot',
] as const;

export type BrowserWorkspaceOperation = (typeof BROWSER_WORKSPACE_OPERATIONS)[number];

/** A concrete grant binding; repository ids never form a cross-workspace wildcard. */
export interface BrowserWorkspaceBinding {
  workspaceId: string;
  repositoryIds: string[];
}

export function isBrowserWorkspaceOperation(value: unknown): value is BrowserWorkspaceOperation {
  return (
    typeof value === 'string' && (BROWSER_WORKSPACE_OPERATIONS as readonly string[]).includes(value)
  );
}

/**
 * The decrypted command union used by Desktop executors. The envelope keeps
 * `params` opaque on the relay; operation-specific handlers may refine their
 * own parameter object without widening the wire operation allowlist.
 */
export type BrowserWorkspacePlaintextCommand = {
  [Operation in BrowserWorkspaceOperation]: {
    operation: Operation;
    workspaceId: string;
    repositoryId?: string;
    params: Record<string, unknown>;
  };
}[BrowserWorkspaceOperation];

/** Typed extension point for operation-specific decrypted result payloads. */
export type BrowserWorkspacePlaintextResult = {
  [Operation in BrowserWorkspaceOperation]: {
    operation: Operation;
    ok: boolean;
    value?: Record<string, unknown>;
    error?: { code: string; message?: string };
  };
}[BrowserWorkspaceOperation];

/** The grant scope required before a Desktop may execute an operation. */
export const BROWSER_WORKSPACE_OPERATION_SCOPE: Record<BrowserWorkspaceOperation, DashboardScope> =
  {
    'workspace.get': 'workspace-read',
    'repo.list': 'workspace-read',
    'file.list': 'workspace-read',
    'file.read': 'workspace-read',
    'file.write': 'workspace-write',
    'chat.thread.list': 'workspace-read',
    'chat.create': 'submit-task',
    'chat.history.read': 'workspace-read',
    'chat.session.start': 'submit-task',
    'chat.send': 'submit-task',
    'chat.status': 'workspace-read',
    'chat.cancel': 'submit-task',
    'chat.approvals.list': 'workspace-read',
    'chat.approve': 'approve-action',
    'chat.input': 'approve-action',
    'git.status': 'workspace-read',
    'git.diff': 'workspace-read',
    'workflow.list': 'workspace-read',
    'workflow.get': 'workspace-read',
    'workflow.start': 'submit-task',
    'workflow.cancel': 'submit-task',
    'terminal.create': 'terminal',
    'terminal.read': 'terminal',
    'terminal.write': 'terminal',
    'terminal.resize': 'terminal',
    'terminal.close': 'terminal',
    'preview.screenshot': 'preview',
  };

/** Shared transport and decrypted payload ceilings for browser-workspace/1. */
export const BROWSER_WORKSPACE_MAX_RPC_BODY_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_ENVELOPE_BYTES = 384 * 1024;
export const BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES = 256 * 1024;
export const BROWSER_WORKSPACE_MAX_FILE_CONTENT_BYTES = 64 * 1024;
export const BROWSER_WORKSPACE_MAX_FILE_READ_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_HISTORY_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_DIFF_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_TERMINAL_READ_BYTES = 128 * 1024;
export const BROWSER_WORKSPACE_MAX_PREVIEW_PNG_BYTES = 180 * 1024;
export const BROWSER_WORKSPACE_MAX_CHAT_MESSAGE_CHARS = 32_000;

export function isBrowserWorkspaceMutatingOperation(operation: BrowserWorkspaceOperation): boolean {
  return (
    operation === 'file.write' ||
    operation === 'chat.create' ||
    operation === 'chat.session.start' ||
    operation === 'chat.send' ||
    operation === 'chat.approve' ||
    operation === 'chat.input' ||
    operation === 'workflow.start' ||
    operation === 'terminal.create' ||
    operation === 'terminal.write'
  );
}

export const BROWSER_WORKSPACE_COMMAND_ENC = 'aes-256-gcm' as const;
export const BROWSER_WORKSPACE_COMMAND_VERSION = 1 as const;

/** Binding supplied by the Desktop grant/relay after envelope validation. */
export interface BrowserWorkspaceExecutionContext {
  grantId: string;
  workspaceId: string;
  repoIds: readonly string[];
  scopes: readonly DashboardScope[];
  /** Unix epoch milliseconds; unlike the wire envelope this is not a string. */
  expiresAt: number;
  commandId: string;
}

export interface BrowserWorkspaceWorkspaceGetCommand {
  operation: 'workspace.get';
}

export interface BrowserWorkspaceRepoListCommand {
  operation: 'repo.list';
}

export interface BrowserWorkspaceFileListCommand {
  operation: 'file.list';
  repositoryId: string;
  relativePath?: string;
  maxEntries?: number;
}

export interface BrowserWorkspaceFileReadCommand {
  operation: 'file.read';
  repositoryId: string;
  relativePath: string;
  maxBytes?: number;
}

export interface BrowserWorkspaceFileWriteCommand {
  operation: 'file.write';
  repositoryId: string;
  relativePath: string;
  content: string;
  expectedRevision: string | null;
}

export interface BrowserWorkspaceThreadListCommand {
  operation: 'chat.thread.list';
  personaId?: string;
}

export interface BrowserWorkspaceChatCreateCommand {
  operation: 'chat.create';
  personaId: string;
  title?: string;
  repositoryIds?: string[];
  activeRepositoryId?: string | null;
}

export interface BrowserWorkspaceChatHistoryCommand {
  operation: 'chat.history.read';
  threadId: string;
}

export interface BrowserWorkspaceChatSessionStartCommand {
  operation: 'chat.session.start';
  threadId: string;
  repositoryId?: string;
  personaId?: string;
}

export interface BrowserWorkspaceChatSendCommand {
  operation: 'chat.send';
  threadId: string;
  sessionId: string;
  message: string;
}

export interface BrowserWorkspaceChatStatusCommand {
  operation: 'chat.status';
  sessionId: string;
}

export interface BrowserWorkspaceChatCancelCommand {
  operation: 'chat.cancel';
  sessionId: string;
  mode?: 'interrupt' | 'stop';
}

export interface BrowserWorkspaceApprovalsListCommand {
  operation: 'chat.approvals.list';
}

export interface BrowserWorkspaceApprovalCommand {
  operation: 'chat.approve';
  sessionId: string;
  requestKey: string;
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  optionId?: string;
}

export interface BrowserWorkspaceInputCommand {
  operation: 'chat.input';
  sessionId: string;
  requestId: string | number;
  response: unknown;
}

export interface BrowserWorkspaceGitStatusCommand {
  operation: 'git.status';
  repositoryId: string;
}

export interface BrowserWorkspaceGitDiffCommand {
  operation: 'git.diff';
  repositoryId: string;
  relativePath: string;
  staged?: boolean;
}

export interface BrowserWorkspaceWorkflowListCommand {
  operation: 'workflow.list';
}

export interface BrowserWorkspaceWorkflowGetCommand {
  operation: 'workflow.get';
  runId: string;
}

export interface BrowserWorkspaceWorkflowStartCommand {
  operation: 'workflow.start';
  templateId: string;
  repositoryIds: string[];
  kickoff: string;
}

export interface BrowserWorkspaceWorkflowCancelCommand {
  operation: 'workflow.cancel';
  runId: string;
}

export interface BrowserWorkspaceTerminalCreateCommand {
  operation: 'terminal.create';
  repositoryId: string;
}

export interface BrowserWorkspaceTerminalReadCommand {
  operation: 'terminal.read';
  repositoryId: string;
  terminalId: string;
  afterSequence?: number;
}

export interface BrowserWorkspaceTerminalWriteCommand {
  operation: 'terminal.write';
  repositoryId: string;
  terminalId: string;
  data: string;
}

export interface BrowserWorkspaceTerminalResizeCommand {
  operation: 'terminal.resize';
  repositoryId: string;
  terminalId: string;
  cols: number;
  rows: number;
}

export interface BrowserWorkspaceTerminalCloseCommand {
  operation: 'terminal.close';
  repositoryId: string;
  terminalId: string;
}

export interface BrowserWorkspacePreviewScreenshotCommand {
  operation: 'preview.screenshot';
  repositoryId: string;
  refresh?: boolean;
}

export type BrowserWorkspaceCommand =
  | BrowserWorkspaceWorkspaceGetCommand
  | BrowserWorkspaceRepoListCommand
  | BrowserWorkspaceFileListCommand
  | BrowserWorkspaceFileReadCommand
  | BrowserWorkspaceFileWriteCommand
  | BrowserWorkspaceThreadListCommand
  | BrowserWorkspaceChatCreateCommand
  | BrowserWorkspaceChatHistoryCommand
  | BrowserWorkspaceChatSessionStartCommand
  | BrowserWorkspaceChatSendCommand
  | BrowserWorkspaceChatStatusCommand
  | BrowserWorkspaceChatCancelCommand
  | BrowserWorkspaceApprovalsListCommand
  | BrowserWorkspaceApprovalCommand
  | BrowserWorkspaceInputCommand
  | BrowserWorkspaceGitStatusCommand
  | BrowserWorkspaceGitDiffCommand
  | BrowserWorkspaceWorkflowListCommand
  | BrowserWorkspaceWorkflowGetCommand
  | BrowserWorkspaceWorkflowStartCommand
  | BrowserWorkspaceWorkflowCancelCommand
  | BrowserWorkspaceTerminalCreateCommand
  | BrowserWorkspaceTerminalReadCommand
  | BrowserWorkspaceTerminalWriteCommand
  | BrowserWorkspaceTerminalResizeCommand
  | BrowserWorkspaceTerminalCloseCommand
  | BrowserWorkspacePreviewScreenshotCommand;

export interface BrowserWorkspaceCommandFailure {
  code:
    | 'expired'
    | 'forbidden'
    | 'not-found'
    | 'invalid-command'
    | 'invalid-path'
    | 'secret-path'
    | 'stale-revision'
    | 'conflict'
    | 'result-too-large'
    | 'unsupported';
  message: string;
  currentRevision?: string | null;
}

export interface BrowserWorkspaceCommandSuccess<T = unknown> {
  commandId: string;
  ok: true;
  data: T;
}

export interface BrowserWorkspaceCommandFailureResult {
  commandId: string;
  ok: false;
  error: BrowserWorkspaceCommandFailure;
}

export type BrowserWorkspaceCommandResult<T = unknown> =
  | BrowserWorkspaceCommandSuccess<T>
  | BrowserWorkspaceCommandFailureResult;

/**
 * Opaque command envelope. `ct` contains the operation parameters and never
 * appears in coordinator-readable metadata. The clear fields are repeated in
 * AAD and must be compared with the grant before the Desktop executes it.
 */
export interface BrowserWorkspaceCommandEnvelope {
  v: typeof BROWSER_WORKSPACE_COMMAND_VERSION;
  enc: typeof BROWSER_WORKSPACE_COMMAND_ENC;
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
  /** base64 12-byte AES-GCM nonce. */
  nonce: string;
  /** base64 ciphertext || GCM tag. */
  ct: string;
}

export interface BrowserWorkspaceCommandAssociatedData {
  backendId: string;
  accountId: string;
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
}

/** Canonical AAD shared by browser and Desktop AES-GCM implementations. */
export function browserWorkspaceCommandAssociatedData(
  value: BrowserWorkspaceCommandAssociatedData,
): string {
  return [
    'anvil/browser-workspace-command/v1',
    value.backendId,
    value.accountId,
    value.requestId,
    value.commandId,
    value.operation,
    value.workspaceId,
    value.repositoryId ?? '',
    value.expiresAt,
  ].join('|');
}

/** Opaque result returned by the Desktop after opening and executing a command. */
export interface BrowserWorkspaceResultEnvelope {
  v: typeof BROWSER_WORKSPACE_COMMAND_VERSION;
  enc: typeof BROWSER_WORKSPACE_COMMAND_ENC;
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
  /** base64 12-byte AES-GCM nonce. */
  nonce: string;
  /** base64 ciphertext || GCM tag. */
  ct: string;
}

/** Results have a distinct domain separator so a command cannot be reflected
 * as a result envelope under the same key. */
export function browserWorkspaceResultAssociatedData(
  value: BrowserWorkspaceCommandAssociatedData,
): string {
  return [
    'anvil/browser-workspace-result/v1',
    value.backendId,
    value.accountId,
    value.requestId,
    value.commandId,
    value.operation,
    value.workspaceId,
    value.repositoryId ?? '',
    value.expiresAt,
  ].join('|');
}

export type DashboardCommandState =
  | 'queued'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'revoked'
  | 'unknown-outcome';

export interface DashboardCommandSubmitParams {
  requestId: string;
  command: BrowserWorkspaceCommandEnvelope;
}

export interface DashboardCommandSubmitResult {
  requestId: string;
  commandId: string;
  state: DashboardCommandState;
  deduplicated: boolean;
  expiresAt: string;
}

export interface DashboardCommandClaimParams {
  requestId: string;
  limit?: number;
}

export interface DashboardClaimedCommand {
  commandId: string;
  requestId: string;
  envelope: BrowserWorkspaceCommandEnvelope;
  claimFence: number;
  claimExpiresAt: string;
}

export interface DashboardCommandClaimResult {
  requestId: string;
  commands: DashboardClaimedCommand[];
}

export interface DashboardCommandCompleteParams {
  requestId: string;
  commandId: string;
  claimFence: number;
  outcome: 'completed' | 'failed';
  result: BrowserWorkspaceResultEnvelope;
}

export interface DashboardCommandCompleteResult {
  requestId: string;
  commandId: string;
  state: 'completed' | 'failed' | 'unknown-outcome';
}

export interface DashboardCommandStatusParams {
  requestId: string;
  commandId: string;
}

/** Hosted status intentionally returns only the opaque result envelope. */
export interface DashboardCommandStatusResult {
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  state: DashboardCommandState;
  expiresAt: string;
  result?: BrowserWorkspaceResultEnvelope;
}
