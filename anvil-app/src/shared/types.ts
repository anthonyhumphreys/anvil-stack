export interface RepoInfo {
  id: string; // SHA256 of repo path
  name: string; // Directory name
  path: string; // Absolute path on disk
  remoteUrl?: string; // ADO/GitHub remote
  defaultBranch: string;
  languages: LanguageBreakdown[];
  status: 'connected' | 'indexing' | 'indexed' | 'error';
  lastIndexed?: string; // ISO timestamp
  fileCount: number;
  branchCount: number;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  indexMode?: 'deep' | 'light';
  indexProvider?: string;
  indexWarnings?: string[];
}

export interface LanguageBreakdown {
  language: string;
  percentage: number;
  fileCount: number;
}

export interface RepoSummary {
  repoId: string;
  overview: string;
  modules: ModuleSummary[];
  patterns: string[];
  frameworks: string[];
  testCoverage?: string;
  entryPoints: string[];
  configFiles: string[];
  mermaidDiagram: string;
  indexMode?: 'deep' | 'light';
  indexProvider?: string;
  indexWarnings?: string[];
}

export type CicdProvider = 'github-actions' | 'azure-pipelines';
export type CicdNodeType = 'workflow' | 'stage' | 'job' | 'step' | 'gate' | 'template';
export type CicdValidationSeverity = 'error' | 'warning' | 'info';

export interface CicdPipelineFile {
  path: string;
  provider: CicdProvider;
  role: 'entrypoint' | 'template' | 'reusable-workflow';
  name: string;
  valid: boolean;
  error?: string;
  content: string;
}

export interface CicdFlowNode {
  id: string;
  type: CicdNodeType;
  provider: CicdProvider;
  filePath: string;
  label: string;
  subtitle?: string;
  status: 'configured' | 'warning' | 'error';
  depth: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface CicdFlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface CicdValidationFinding {
  id: string;
  severity: CicdValidationSeverity;
  provider: CicdProvider;
  filePath: string;
  message: string;
  nodeId?: string;
}

export interface CicdPipelineAnalysis {
  repoId: string;
  repoName: string;
  generatedAt: string;
  files: CicdPipelineFile[];
  nodes: CicdFlowNode[];
  edges: CicdFlowEdge[];
  findings: CicdValidationFinding[];
  summary: {
    providers: CicdProvider[];
    workflowCount: number;
    stageCount: number;
    jobCount: number;
    stepCount: number;
    gateCount: number;
    templateCount: number;
  };
}

export interface CicdCreatePipelineInput {
  provider: CicdProvider;
  template: 'node-ci' | 'dotnet-azure' | 'gated-release';
  name: string;
  filePath?: string;
}

export interface CicdCreatePipelineResult {
  filePath: string;
  content: string;
}

export type RepoIndexStage =
  | 'queued'
  | 'discovering'
  | 'preparing-deep-index'
  | 'syncing-deep-index'
  | 'gathering-context'
  | 'synthesizing'
  | 'analysing-module'
  | 'generating-summary'
  | 'saving'
  | 'complete'
  | 'error';

export interface RepoIndexProgress {
  repoId: string;
  message: string;
  percent: number;
  stage: RepoIndexStage;
  detail?: string;
}

export interface ModuleSummary {
  path: string;
  purpose: string;
  fileCount: number;
  keyFiles: string[];
  dependencies: string[];
}

export interface OnboardDetection {
  repoId: string;
  agentsMdExists: boolean;
  agentsMdPath?: string;
  agentsMdStaleness?: 'current' | 'stale' | 'missing';
  devcontainerExists: boolean;
  devcontainerPath?: string;
  readmeExists: boolean;
  environmentStatus: EnvironmentCheck[];
  suggestedActions: OnboardAction[];
}

export interface EnvironmentCheck {
  name: string;
  required: boolean;
  installed: boolean;
  version?: string;
  installCommand?: string;
}

export type OnboardAction =
  | 'generate-agents-md'
  | 'update-agents-md'
  | 'generate-devcontainer'
  | 'update-devcontainer'
  | 'install-dependencies'
  | 'generate-env-template'
  | 'generate-readme';

export type WorkItemProvider = 'ado' | 'linear' | 'jira';
export type DocsProvider = 'confluence' | 'notion';

export interface WorkItem {
  id: string;
  title: string;
  type: 'Bug' | 'User Story' | 'Feature' | 'Task' | 'Epic';
  state: string;
  priority: number;
  assignee?: string;
  description?: string;
  acceptanceCriteria?: string;
  repoUrl?: string;
  linkedCommits?: string[];
  tags?: string[];
  iterationPath?: string;
  parentId?: string;
  children?: WorkItem[];
  provider: WorkItemProvider;
  extras?: Record<string, unknown>;
  url?: string;
}

export interface WorkItemCreateInput {
  title: string;
  description?: string;
  parentId?: string;
}

export type BaFindingType = 'compliance' | 'feasibility' | 'dependency' | 'question' | 'risk';
export type BaFindingStatus = 'open' | 'dismissed' | 'resolved';
export type BaSessionStatus = 'active' | 'completed' | 'orphaned';

export interface BaFinding {
  id: string;
  workItemId: string;
  repoId: string;
  sessionId?: string;
  type: BaFindingType;
  content: string;
  status: BaFindingStatus;
  sourceMessageId?: string;
  followUpWorkItemId?: string;
  followUpWorkItemProvider?: WorkItemProvider;
  followUpWorkItemTitle?: string;
  followUpWorkItemUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BaSession {
  id: string;
  workItemId: string;
  repoId: string;
  spikeBranch: string;
  originBranch: string;
  worktreePath?: string;
  stashRef?: string;
  status: BaSessionStatus;
  startedAt: string;
  endedAt?: string;
}

export interface BaMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  eventType?: string;
  createdAt: string;
}

export interface BaRepoLink {
  workItemId: string;
  repoId: string;
  linkedAt: string;
}

export interface WorkItemFilters {
  state?: string;
  type?: string;
  assignee?: string;
  tags?: string[];
  iterationIds?: string[];
}

export interface Iteration {
  id: string;
  name: string;
  path?: string;
  startDate?: string;
  finishDate?: string;
  provider: WorkItemProvider;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  repoContext?: string;
  personaId?: string;
  threadId?: string;
  sessionId?: string;
  citations?: Citation[];
  attachments?: ChatAttachment[];
}

export type ChatArtifactKind = 'markdown' | 'code' | 'html' | 'diagram' | 'data' | 'text';

export interface ChatArtifact {
  id: string;
  threadId: string;
  repoId?: string;
  sourceMessageId?: string;
  title: string;
  kind: ChatArtifactKind;
  relativePath: string;
  filePath?: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatArtifactInput {
  threadId: string;
  repoId?: string | null;
  sourceMessageId?: string;
  title: string;
  kind: ChatArtifactKind;
  relativePath: string;
  content: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  path: string;
  createdAt: string;
}

export interface ChatAttachmentInput {
  id?: string;
  name: string;
  mimeType?: string;
  size?: number;
  path?: string;
  dataUrl?: string;
}

/** Reasoning effort levels supported by the Codex CLI (`model_reasoning_effort`). */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ChatSendOptions {
  collaborationMode?: ChatCollaborationMode;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatFileMentionSearchInput {
  repoIds: string[];
  query?: string;
  limit?: number;
}

export interface ChatFileMentionSearchResult {
  repoId: string;
  repoName: string;
  relativePath: string;
  name: string;
  path: string;
  size: number;
}

export interface ChatThread {
  id: string;
  personaId: string;
  title: string;
  workspaceId?: string;
  workItemId?: string;
  workItemProvider?: WorkItemProvider;
  workItemTitle?: string;
  repoIds: string[];
  activeRepoId?: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  preview?: string;
  messageCount: number;
  providerThreadId?: string;
  activePlan?: ChatPlanSnapshot;
  activeGoal?: ChatGoalSnapshot;
}

export type ChatCollaborationMode = 'default' | 'plan';
export type ChatLayout = 'classic' | 'workitems';

export type ChatPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface ChatPlanStep {
  step: string;
  status: ChatPlanStepStatus;
}

export interface ChatPlanSnapshot {
  explanation?: string;
  steps: ChatPlanStep[];
  updatedAt: string;
}

export type ChatGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

export interface ChatGoalSnapshot {
  objective: string;
  status: ChatGoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export type TurnEvidenceItemType =
  | 'file_edit'
  | 'file_read'
  | 'command'
  | 'approval'
  | 'tool'
  | 'error'
  | 'plan'
  | 'goal';

export interface TurnEvidenceItem {
  id: string;
  type: TurnEvidenceItemType;
  label: string;
  detail?: string;
  filePath?: string;
  command?: string;
  exitCode?: number;
  failed?: boolean;
  diff?: string;
  timestamp: string;
}

export interface ChatTurnSummary {
  id: string;
  threadId: string;
  userMessageId: string;
  userPrompt: string;
  startedAt: string;
  completedAt?: string;
  assistantMessageId?: string;
  assistantPreview?: string;
  changedFiles: string[];
  commands: TurnEvidenceItem[];
  tests: TurnEvidenceItem[];
  errors: TurnEvidenceItem[];
  evidence: TurnEvidenceItem[];
}

export type AgentRunSource = 'chat' | 'automation' | 'code_review';
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentRunSummary {
  id: string;
  source: AgentRunSource;
  title: string;
  status: AgentRunStatus;
  workspaceId?: string;
  repoIds: string[];
  threadId?: string;
  sessionId?: string;
  automationId?: string;
  reviewId?: string;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  changedFileCount: number;
  evidenceCount: number;
}

export interface AutomationTriageItem {
  id: string;
  automationId: string;
  automationName: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  startedAt: string;
  completedAt?: string;
  changedFileCount: number;
  summary?: string;
  errorMessage?: string;
  retainedWorktreeCount: number;
  worktrees: AutomationRunWorktree[];
  attention: 'blocked' | 'changes' | 'running';
}

export type JsonRpcRequestId = string | number;

export interface CodexEvent {
  type:
    | 'text'
    | 'thinking'
    | 'file_read'
    | 'file_edit'
    | 'command_exec'
    | 'tool_call'
    | 'approval_request'
    | 'plan_update'
    | 'goal_update'
    | 'goal_cleared'
    | 'error'
    | 'status';
  text?: string;
  filePath?: string;
  diff?: string;
  lineRange?: [number, number];
  command?: string;
  output?: string;
  exitCode?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  approvalRequestId?: JsonRpcRequestId;
  approvalKind?: 'command' | 'file_change';
  approvalReason?: string;
  approvalCommand?: string;
  approvalCwd?: string;
  approvalGrantRoot?: string;
  plan?: ChatPlanSnapshot;
  goal?: ChatGoalSnapshot;
  status?: 'thinking' | 'executing' | 'complete' | 'error';
  errorMessage?: string;
}

export interface Persona {
  id: string;
  name: string;
  icon: string;
  colour: string;
  description: string;
  systemPromptTemplate: string;
  capabilities: {
    canWriteFiles: boolean;
    canRunCommands: boolean;
    canReadFiles: boolean;
  };
}

export interface CodexSession {
  id: string;
  repoId?: string;
  workspaceId?: string;
  appThreadId?: string;
  kind?: 'repo' | 'workspace' | 'scaffold';
  personaId: string;
  status: 'starting' | 'ready' | 'busy' | 'error';
  startedAt: string;
  mode?: CodexMode;
  providerThreadId?: string;
  currentTurnId?: string;
  resumable?: boolean;
}

export type CodexMode = 'read-only' | 'on-request' | 'workspace-auto' | 'full-access';

// ---------------------------------------------------------------------------
// Mobile Companion
// ---------------------------------------------------------------------------

export interface MobileCompanionAdvertisedAddress {
  label: string;
  url: string;
  kind: 'lan' | 'tailscale' | 'loopback';
}

export interface MobileCompanionStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  baseUrl: string | null;
  advertisedAddresses: MobileCompanionAdvertisedAddress[];
  pairedDeviceCount: number;
}

export type CompanionSurface = 'desktop' | 'mobile' | 'watch' | 'widget' | 'carplay' | 'siri';

export type MobileCompanionClientType =
  | 'mobile'
  | 'raycast'
  | 'watch'
  | 'widget'
  | 'menubar'
  | 'carplay'
  | 'siri';

export interface MobilePairingTicket {
  ticket: string;
  expiresAt: string;
  pairingUrl: string;
  qrSvg: string;
}

export interface RaycastCompanionToken {
  baseUrl: string;
  token: string;
  device: MobileCompanionDevice;
}

export interface MobileCompanionDevice {
  id: string;
  name: string;
  clientType: MobileCompanionClientType;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface MobileApprovalRequest {
  sessionId: string;
  requestKey: string;
  requestId: JsonRpcRequestId;
  kind: 'command' | 'file_change';
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  workspaceId?: string;
  workspaceName?: string;
  repoId?: string;
  repoName?: string;
  policy?: CompanionApprovalPolicy;
  createdAt: string;
}

export type CompanionApprovalRisk = 'low' | 'medium' | 'high' | 'destructive';

export interface CompanionApprovalPolicy {
  risk: CompanionApprovalRisk;
  requiresFullReview: boolean;
  allowedSurfaces: CompanionSurface[];
  summary: string;
  requestedAction: string;
  blockedReason?: string;
}

export interface CarPlayApprovalRequest extends MobileApprovalRequest {
  id: string;
  title: string;
  workspaceId?: string;
  workspaceName?: string;
  repo?: string;
  summary: string;
  requestedAction: string;
  risk: CompanionApprovalRisk;
  requiresFullReview: boolean;
  allowedSurfaces: CompanionSurface[];
  carPlayApprovable: boolean;
  blockedReason?: string;
  markedForLater: boolean;
}

export type CarPlaySessionStatus = 'active' | 'paused' | 'blocked' | 'completed';

export interface CarPlaySessionSummary {
  id: string;
  workspaceId?: string;
  workspaceName?: string;
  repo?: string;
  title: string;
  status: CarPlaySessionStatus;
  summary: string;
  updatedAt: string;
}

export interface WorkspaceNote {
  id: string;
  workspaceId?: string;
  workspaceName?: string;
  repo?: string;
  body: string;
  source: CompanionSurface | 'desktop';
  status: 'open' | 'accepted' | 'dismissed';
  createdAt: string;
  reviewedAt?: string;
}

export interface WorkspaceNoteCreateInput {
  workspaceId?: string;
  repo?: string;
  body: string;
  source: CompanionSurface | 'desktop';
}

export interface CarPlayDriveSnapshot {
  generatedAt: string;
  title: 'Anvil Drive';
  attention: {
    pendingApprovals: number;
    blockedSessions: number;
    requiresDesktopReview: number;
    failedChecks: number;
  };
  sessions: CarPlaySessionSummary[];
  approvals: CarPlayApprovalRequest[];
  recentNotes: WorkspaceNote[];
  safeActions: Array<{
    id:
      | 'pause-all'
      | 'continue-low-risk-checks'
      | 'prepare-handover'
      | 'mark-everything-later'
      | 'capture-note';
    label: string;
    enabled: boolean;
  }>;
}

export interface CarPlayNoteRequest {
  workspaceId?: string;
  repo?: string;
  body: string;
  source: 'carplay' | 'siri';
}

export interface MobileCompanionNotification {
  id: string;
  type: 'overview' | 'approvals' | 'sessions' | 'settings' | 'notes' | 'carplay' | 'handover';
  surface?: CompanionSurface;
  title: string;
  body: string;
  createdAt: string;
}

export interface MobileChatThreadSummary {
  id: string;
  personaId: string;
  title: string;
  workspaceId?: string;
  preview?: string;
  messageCount: number;
  updatedAt: string;
  activeSessionId?: string;
  activeSessionStatus?: CodexSession['status'];
  pendingApprovalCount: number;
}

export type MobileWorkflowHealth = 'needs-approval' | 'busy' | 'ready' | 'idle' | 'unconfigured';

export interface MobileWorkflowDigest {
  health: MobileWorkflowHealth;
  headline: string;
  detail: string;
  counts: {
    pendingApprovals: number;
    activeSessions: number;
    busySessions: number;
    readySessions: number;
    recentThreads: number;
    workspaceRepos: number;
  };
}

export type MobileWorkQueueItemKind = 'approval' | 'session' | 'thread';
export type MobileWorkQueueItemPriority = 'critical' | 'high' | 'normal' | 'low';

export interface MobileWorkQueueItem {
  id: string;
  kind: MobileWorkQueueItemKind;
  priority: MobileWorkQueueItemPriority;
  title: string;
  detail: string;
  statusLabel: string;
  updatedAt: string;
  workspaceId?: string;
  workspaceName?: string;
  repoId?: string;
  repoName?: string;
  sessionId?: string;
  threadId?: string;
  requestKey?: string;
  risk?: CompanionApprovalRisk;
  requiresDesktopReview?: boolean;
  actionLabel?: string;
}

export interface MobileQuickAction {
  id: string;
  title: string;
  subtitle: string;
  prompt: string;
  personaId: string;
  tone: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple';
  requiresActiveWorkspace: boolean;
}

export interface MobileStartChatInput {
  actionId?: string;
  message?: string;
  title?: string;
  personaId?: string;
  workspaceId?: string;
  repoIds?: string[];
  collaborationMode?: ChatCollaborationMode;
}

export interface MobileStartChatResult {
  thread: MobileChatThreadSummary;
  session: CodexSession;
  queuedMessage: string;
}

export interface MobileOverview {
  generatedAt: string;
  activeWorkspace?: WorkspaceWithRepos;
  workspaces: WorkspaceSummary[];
  activeSessions: CodexSession[];
  pendingApprovals: MobileApprovalRequest[];
  threads: MobileChatThreadSummary[];
  workQueue: MobileWorkQueueItem[];
  workflow: MobileWorkflowDigest;
  quickActions: MobileQuickAction[];
  companion: MobileCompanionStatus;
  notifications: MobileCompanionNotification[];
}

export interface MobilePairingPayload {
  app: 'anvil';
  version: 1;
  instanceId: string;
  baseUrl: string;
  ticket: string;
  expiresAt: string;
}

export interface Citation {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  lastUpdated: string;
  lastUpdatedBy: string;
  url: string;
  staleness?: 'current' | 'stale' | 'unknown';
  labels?: string[];
  parentId?: string;
  provider: 'confluence';
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastUpdated: string;
  lastUpdatedBy: string;
  staleness?: 'current' | 'stale' | 'unknown';
  labels?: string[];
  parentId?: string;
  provider: 'notion';
}

export type DocPage = ConfluencePage | NotionPage;

export type SecurityAuditStatus = 'running' | 'completed' | 'failed';
export type SecurityFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityAudit {
  id: string;
  repoId: string;
  scope: string[];
  status: SecurityAuditStatus;
  summary?: string;
  startedAt: string;
  completedAt?: string;
  modelVersion?: string;
}

export interface SecurityFinding {
  id: string;
  auditId: string;
  severity: SecurityFindingSeverity;
  category: string;
  owaspRef?: string;
  cweRef?: string;
  affectedFiles: string[];
  description: string;
  remediation?: string;
  workItemId?: string;
  dismissed: boolean;
}

// ---------------------------------------------------------------------------
// Code Review
// ---------------------------------------------------------------------------

export type CodeReviewStatus = 'running' | 'completed' | 'failed';
export type CodeReviewFindingSeverity = 'critical' | 'major' | 'minor' | 'suggestion' | 'nitpick';
export type CodeReviewMode = 'quick_glance' | 'senior_dev';
export type CodeReviewVerificationStatus = 'not_run' | 'passed' | 'failed' | 'partial';
export type CodeReviewVerificationStepStatus = 'passed' | 'failed' | 'skipped';
export type CodeReviewScopeType =
  | 'latest_commit'
  | 'commit_range'
  | 'branch_diff'
  | 'pull_request'
  | 'full_codebase';

export interface CodeReviewPullRequestRef {
  id: string;
  title?: string;
  url?: string;
  sourceBranch?: string;
  targetBranch?: string;
  provider?: 'github' | 'ado';
}

export interface CodeReviewScopeRef {
  fromSha?: string;
  toSha?: string;
  baseBranch?: string;
  compareBranch?: string;
  pullRequest?: CodeReviewPullRequestRef;
}

export interface CodeReviewPullRequest {
  id: string;
  title: string;
  provider: 'github' | 'ado';
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  author?: string;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: string;
  url?: string;
}

export interface CodeReviewPullRequestComment {
  id?: string;
  url?: string;
  postedAt: string;
}

export interface CodeReviewVerificationStep {
  label: string;
  command: string;
  status: CodeReviewVerificationStepStatus;
  exitCode?: number;
  durationMs: number;
  outputSnippet?: string;
}

export interface CodeReviewVerification {
  status: CodeReviewVerificationStatus;
  summary?: string;
  targetRef?: string;
  worktreePath?: string;
  worktreeKept?: boolean;
  steps: CodeReviewVerificationStep[];
}

export interface CodeReview {
  id: string;
  repoId: string;
  mode: CodeReviewMode;
  scopeType: CodeReviewScopeType;
  scopeRef?: CodeReviewScopeRef;
  status: CodeReviewStatus;
  summary?: string;
  rubricUsed?: string;
  verification?: CodeReviewVerification;
  startedAt: string;
  completedAt?: string;
}

export interface CodeReviewFinding {
  id: string;
  reviewId: string;
  severity: CodeReviewFindingSeverity;
  category: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  description: string;
  suggestion?: string;
  workItemId?: string;
  pullRequestComment?: CodeReviewPullRequestComment;
  dismissed: boolean;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type WorkspaceCreationMode = 'empty' | 'existing' | 'scaffold';
export type WorkspaceScaffoldStatus =
  | 'active'
  | 'syncing'
  | 'indexing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCreateOptions {
  name: string;
  repoIds?: string[];
}

export interface WorkspaceWorkItemsPreferences {
  iterationIds?: string[];
  iterationNames?: string[];
}

export interface WorkspaceDocsPreferences {
  parentPageId?: string;
  parentPageTitle?: string;
  label?: string;
}

export interface WorkspaceLaunchPreferences {
  source?: 'deeplink' | 'manual';
  sourceUrl?: string;
  requestedAt?: string;
}

export interface WorkspacePreferences {
  workspaceId: string;
  workitems: WorkspaceWorkItemsPreferences;
  docs: WorkspaceDocsPreferences;
  launch: WorkspaceLaunchPreferences;
  updatedAt: string;
}

export interface WorkspaceScaffoldSession {
  id: string;
  workspaceId: string;
  rootPath: string;
  personaId: string;
  status: WorkspaceScaffoldStatus;
  completion?: {
    repos: Array<{ name: string; path: string }>;
  };
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkspaceFeatureAvailability {
  statusLabel: 'empty' | 'scaffolding' | 'indexing' | 'ready';
  chatEnabled: boolean;
  repoFeaturesEnabled: boolean;
  repoFeatureReason?: string;
}

export interface WorkspaceWithRepos extends Workspace {
  repos: RepoInfo[];
  preferences?: WorkspacePreferences;
  scaffoldSession?: WorkspaceScaffoldSession;
}

export interface WorkspaceSummary extends Workspace {
  repoCount: number;
}

export interface WorkspaceScaffoldStartResult {
  workspaceId: string;
  scaffoldSession: WorkspaceScaffoldSession;
}

export interface WorkspaceScaffoldMaybeCompleteResult {
  triggered: boolean;
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export type AutomationExecutionMode = 'disposable-worktree';
export type AutomationRunTrigger = 'manual' | 'schedule';
export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AutomationLoopMode = 'sequence' | 'dynamic';
export type AutomationEventType =
  | 'status'
  | 'text'
  | 'thinking'
  | 'file_edit'
  | 'command_exec'
  | 'tool_call'
  | 'error'
  | 'system';

export interface AutomationLoopConfig {
  enabled: boolean;
  mode: AutomationLoopMode;
  memberPersonaIds: string[];
  separateThreads: boolean;
  maxIterations: number;
  stopCondition: string;
}

export interface AutomationDefinitionInput {
  name: string;
  personaId: string;
  prompt: string;
  repoIds: string[];
  scheduleCron: string;
  timezone: string;
  enabled: boolean;
  allowRepoWrite: boolean;
  allowCommandRun: boolean;
  loopConfig?: AutomationLoopConfig;
}

export interface AutomationDefinition extends AutomationDefinitionInput {
  id: string;
  workspaceId: string;
  executionMode: AutomationExecutionMode;
  lastRunAt?: string;
  nextRunAt?: string;
  lastRunStatus?: AutomationRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunWorktree {
  repoId: string;
  repoName: string;
  branchName: string;
  path?: string;
  kept: boolean;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  workspaceId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  startedAt: string;
  completedAt?: string;
  assistantMessage?: string;
  errorMessage?: string;
  changedFileCount: number;
  worktrees: AutomationRunWorktree[];
}

export interface AutomationRunEvent {
  id: string;
  runId: string;
  type: AutomationEventType;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AutomationDaemonStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  mode: 'app' | 'daemon';
  label?: string;
  plistPath?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// DB Insights
// ---------------------------------------------------------------------------

export type DbInsightFileType = 'sql' | 'txt' | 'json' | 'other';
export type DbInsightArtifactCategory = 'schema' | 'stored-procedure' | 'mixed' | 'other';
export type DbInsightAnalysisStatus = 'running' | 'completed' | 'failed';

export interface DbInsightArtifact {
  id: string;
  workspaceId: string;
  filePath: string;
  fileName: string;
  fileType: DbInsightFileType;
  category: DbInsightArtifactCategory;
  fileSize: number;
  addedAt: string;
  updatedAt: string;
}

export interface DbInsightTable {
  schema: string;
  name: string;
  qualifiedName: string;
  columnCount: number;
  keyColumns: string[];
  notes?: string;
}

export interface DbInsightStoredProcedure {
  schema: string;
  name: string;
  qualifiedName: string;
  purpose?: string;
  referencedObjects: string[];
}

export interface DbInsightAnalysis {
  id: string;
  workspaceId: string;
  artifactIds: string[];
  status: DbInsightAnalysisStatus;
  summary: string;
  databaseName?: string;
  tableCount: number;
  procedureCount: number;
  viewCount: number;
  functionCount: number;
  tables: DbInsightTable[];
  storedProcedures: DbInsightStoredProcedure[];
  relationships: string[];
  risks: string[];
  recommendedQuestions: string[];
  startedAt: string;
  completedAt?: string;
}

export interface OpenInAnvilRepoSpec {
  cloneUrl: string;
  provider: 'github' | 'ado';
  name?: string;
}

export interface OpenInAnvilLaunchIntent {
  workspaceName?: string;
  repos: OpenInAnvilRepoSpec[];
  iterationId?: string;
  iterationName?: string;
  docsParentId?: string;
  docsParentTitle?: string;
  sourceUrl: string;
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type AppTheme =
  | 'system'
  | 'dark'
  | 'prompt-whisperer'
  | 'merge-conflict'
  | 'token-bender'
  | 'agent-after-hours';

export interface AppSettings {
  llmProvider: 'azure' | 'openai' | 'codex';
  appleFoundationModelsMode: 'off' | 'prefer-simple';

  // Azure AI Foundry
  foundryEndpoint: string;
  foundryDeploymentName: string;
  foundryApiVersion: string;
  foundryApiKey?: string;

  // OpenAI
  openaiApiKey?: string;
  openaiModel: string; // e.g. "gpt-5.5", "gpt-5.4", "gpt-5.3-codex"
  reasoningLevel: 'low' | 'medium' | 'high';
  codexMode: CodexMode;
  chatLayout: ChatLayout;

  // Work Item Provider
  workItemProvider: WorkItemProvider | 'none';

  // ADO
  adoOrganizationUrl: string;
  adoProject: string;
  adoTeam?: string;
  adoPat?: string;

  // Linear
  linearApiKey?: string;
  linearTeamId?: string;

  // JIRA
  jiraHost?: string;
  jiraAuthMode?: 'cloud' | 'server';
  jiraProject?: string;
  jiraBoardId?: string;
  jiraEmail?: string;
  jiraApiToken?: string;

  confluenceBaseUrl: string;
  confluenceSpaceKey: string;
  confluencePat?: string;
  docsProvider: DocsProvider | 'none';
  notionOauthToken?: string;
  notionOauthExpiry?: string;
  notionDatabaseId?: string;

  // Code Review
  codeReviewQuickGlanceRubric?: string;
  codeReviewSeniorDevRubric?: string;

  defaultRepoPath?: string;
  activeWorkspaceId?: string;
  githubPat?: string;
  githubUsername?: string;
  cloudFeaturesEnabled: boolean;
  theme: AppTheme;
  userRole?: UserRole;
}

// ---------------------------------------------------------------------------
// Codex registry
// ---------------------------------------------------------------------------

export interface CodexRegistryCliStatus {
  installed: boolean;
  version?: string;
  path?: string;
  codexHome: string;
  configPaths: string[];
  authConfigured: boolean;
}

export type CodexSkillScope =
  | 'codex-global'
  | 'codex-system'
  | 'user-agents'
  | 'project'
  | 'plugin'
  | 'unknown';

export interface CodexRegisteredSkill {
  id: string;
  name: string;
  description?: string;
  path: string;
  directory: string;
  scope: CodexSkillScope;
  source?: string;
  tags?: string[];
  updatedAt?: string;
}

export interface CodexMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'unknown';
  command?: string;
  args?: string[];
  url?: string;
  status?: string;
  auth?: string;
  raw: string;
}

export interface CodexRegistrySnapshot {
  cli: CodexRegistryCliStatus;
  skills: CodexRegisteredSkill[];
  mcpServers: CodexMcpServer[];
  scannedSkillRoots: string[];
  warnings: string[];
  refreshedAt: string;
}

// ---------------------------------------------------------------------------
// Codex usage
// ---------------------------------------------------------------------------

export interface CodexUsageRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexUsageCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexUsageLimitSnapshot {
  id: string;
  label: string;
  planType: string | null;
  rateLimitReachedType: string | null;
  primary: CodexUsageRateLimitWindow | null;
  secondary: CodexUsageRateLimitWindow | null;
  credits: CodexUsageCreditsSnapshot | null;
}

export interface CodexUsageDailyBucket {
  startDate: string;
  tokens: number;
}

export interface CodexUsageTokenSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  recentDailyBuckets: CodexUsageDailyBucket[];
}

export interface CodexUsageSnapshot {
  status: 'available' | 'unavailable';
  refreshedAt: string;
  cliInstalled: boolean;
  cliVersion?: string;
  codexHome?: string;
  appServerUserAgent?: string;
  defaultLimit: CodexUsageLimitSnapshot | null;
  limits: CodexUsageLimitSnapshot[];
  tokenUsage: CodexUsageTokenSummary | null;
  resetCreditsAvailable: number | null;
  error?: string;
}

export interface CodexSkillSearchResult {
  id: string;
  name: string;
  description?: string;
  source: string;
  skillName?: string;
  installCommand: string;
  url?: string;
  repositoryUrl?: string;
  installs?: number;
  weeklyInstalls?: number;
  tags?: string[];
}

export interface CodexSkillInstallInput {
  source: string;
  skillName?: string;
  global?: boolean;
}

// ---------------------------------------------------------------------------
// Anvil Cloud
// ---------------------------------------------------------------------------

export type AnvilCloudCommandId =
  | 'doctor'
  | 'check'
  | 'build'
  | 'inspect-local'
  | 'lens'
  | 'logs-local'
  | 'db-list'
  | 'workflows-list'
  | 'services-list'
  | 'agents-validate'
  | 'agents-manifest'
  | 'agents-sandboxes';

export interface AnvilCloudCliStatus {
  available: boolean;
  command: string;
  version?: string;
  source: 'workspace' | 'wrapper' | 'path';
  cloudWorkspacePath?: string;
  error?: string;
}

export interface AnvilCloudCommandDefinition {
  id: AnvilCloudCommandId;
  label: string;
  description: string;
  command: string;
  category: 'health' | 'build' | 'runtime' | 'agents';
}

export interface AnvilCloudCommandResult {
  ok: boolean;
  commandId: AnvilCloudCommandId;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  parsed?: unknown;
  exitCode?: number;
  durationMs: number;
  completedAt: string;
  error?: string;
}

export interface AnvilCloudWorkbenchSnapshot {
  status: AnvilCloudCliStatus;
  commands: AnvilCloudCommandDefinition[];
}

export interface CodexRegistryActionResult {
  success: boolean;
  command: string;
  output?: string;
  error?: string;
}

export interface CodexMcpRegisterInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  bearerTokenEnvVar?: string;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticMemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface DiagnosticProcessMetric {
  pid: number;
  type: string;
  memoryWorkingSetSize: number;
  memoryPrivateBytes: number;
  memorySharedBytes: number;
  cpuPercentCPUUsage: number;
  cpuIdleWakeupsPerSecond: number;
}

export interface DiagnosticFeatureMetric {
  id: string;
  label: string;
  count: number;
  bytes?: number;
  detail?: string;
}

export interface DiagnosticsSnapshot {
  capturedAt: string;
  mainProcess: {
    pid: number;
    platform: NodeJS.Platform;
    arch: string;
    uptimeSeconds: number;
    memory: DiagnosticMemoryUsage;
  };
  processes: DiagnosticProcessMetric[];
  featureMetrics: DiagnosticFeatureMetric[];
}

export interface DiagramFile {
  filename: string; // e.g. "auth-flow.drawio"
  title: string; // derived from filename: "auth-flow"
  xml: string; // draw.io XML content
  mtime: number; // file modification timestamp (ms)
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'nuget' | 'python';
export type SbomFormat = 'cyclonedx-json' | 'spdx-json' | 'csv';

export interface DependencyRecord {
  name: string;
  version: string;
  manager: PackageManager;
  deprecated?: boolean;
  license?: string;
  alternative?: string;
}

export interface DependencyAuditResult {
  manager: PackageManager;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export interface LicenseAuditResult {
  generatedAt: string;
  total: number;
  unknown: number;
  packages: DependencyRecord[];
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type UserRole = 'developer' | 'ba-brm' | 'design';

export type Feature =
  | 'repos'
  | 'chat'
  | 'editor'
  | 'automations'
  | 'dbinsights'
  | 'onboard'
  | 'workitems'
  | 'dependencies'
  | 'security'
  | 'codereview'
  | 'cicd'
  | 'docs'
  | 'adrs'
  | 'diagrams'
  | 'governance'
  | 'browser'
  | 'argent'
  | 'git'
  | 'compliance'
  | 'cloud'
  | 'meeting-notes'
  | 'workspace-notes';

export const ROLE_FEATURES: Record<UserRole, readonly Feature[]> = {
  developer: [
    'repos',
    'chat',
    'editor',
    'automations',
    'dbinsights',
    'onboard',
    'workitems',
    'dependencies',
    'security',
    'codereview',
    'cicd',
    'docs',
    'adrs',
    'diagrams',
    'governance',
    'browser',
    'argent',
    'git',
    'compliance',
    'cloud',
    'meeting-notes',
    'workspace-notes',
  ],
  'ba-brm': [
    'repos',
    'chat',
    'editor',
    'dbinsights',
    'workitems',
    'dependencies',
    'cicd',
    'docs',
    'adrs',
    'diagrams',
    'governance',
    'compliance',
    'cloud',
    'meeting-notes',
    'workspace-notes',
  ],
  design: [
    'repos',
    'chat',
    'dbinsights',
    'docs',
    'diagrams',
    'governance',
    'compliance',
    'cloud',
    'meeting-notes',
    'workspace-notes',
  ],
} as const;

export interface RemoteRepo {
  name: string;
  cloneUrl: string;
  provider: 'github' | 'ado';
  description?: string;
  visibility?: 'public' | 'private';
  defaultBranch?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export interface GovernanceBoard {
  id: string;
  workspaceId: string;
  name: string; // e.g. "Technical Design Authority"
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GovernanceDocument {
  id: string;
  workspaceId: string;
  boardId?: string; // optional association to a board
  filePath: string; // absolute path on disk
  fileName: string;
  fileType: GovernanceFileType;
  fileSize: number; // bytes
  description?: string;
  addedAt: string;
  updatedAt: string;
}

export type GovernanceFileType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'other';

// ---------------------------------------------------------------------------
// ADRs (Architecture Decision Records)
// ---------------------------------------------------------------------------

export interface AdrEntry {
  /** Relative path from repo root to the ADR file */
  relativePath: string;
  /** Filename only, e.g. "0001-use-react.md" */
  filename: string;
  /** Title extracted from first markdown heading, falls back to filename */
  title: string;
  /** Raw markdown content */
  content: string;
  /** ADR status if parseable from content (e.g. "Accepted", "Deprecated") */
  status?: string;
}

export interface RepoAdrs {
  repoId: string;
  repoName: string;
  adrs: AdrEntry[];
}

// ---------------------------------------------------------------------------
// Data & Compliance
// ---------------------------------------------------------------------------

export type ComplianceDocType = 'dpia' | 'privacy-policy' | 'terms-of-service';

export interface ComplianceDocument {
  repoId: string;
  repoName: string;
  docType: ComplianceDocType;
  filename: string;
  title: string;
  content: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Browser / Embedded DevTools
// ---------------------------------------------------------------------------

export interface DevServerTarget {
  id: string;
  url: string;
  port: number;
  label: string;
  terminalId?: string;
  detectedAt: string;
}

export interface BrowserBridgeStatus {
  running: boolean;
  port?: number;
  connectedUrl?: string;
}

export interface BrowserAnnotation {
  id: string;
  url: string;
  title?: string;
  note: string;
  selectedText?: string;
  viewport: {
    width: number;
    height: number;
  };
  createdAt: string;
}

export interface SimulatorPreviewStatus {
  running: boolean;
  url?: string;
  metroUrl?: string;
  pid?: number;
  cwd?: string;
  command?: string;
  startedAt?: string;
  lastOutput?: string;
  lastError?: string;
}

export interface SimulatorPreviewStartOptions {
  cwd?: string;
  port?: number;
}

// ---------------------------------------------------------------------------
// Expo Argent
// ---------------------------------------------------------------------------

export type ArgentCommandId = 'install-cli' | 'init-mcp' | 'update' | 'flags';
export type ArgentCommandCategory = 'setup' | 'maintenance';

export interface ArgentCommandDefinition {
  id: ArgentCommandId;
  label: string;
  description: string;
  command: string;
  category: ArgentCommandCategory;
}

export interface ArgentCommandResult {
  ok: boolean;
  commandId: ArgentCommandId;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode?: number | string;
  durationMs: number;
  completedAt: string;
  error?: string;
}

export type ArgentPromptId =
  | 'launch-attach'
  | 'verify-screenshot'
  | 'smoke-flow'
  | 'debug-logs'
  | 'network-request'
  | 'react-tree'
  | 'profile-slowdown'
  | 'deep-link';

export interface ArgentPromptTemplate {
  id: ArgentPromptId;
  label: string;
  description: string;
  prompt: string;
  evidence: string[];
}

export interface ArgentCliStatus {
  installed: boolean;
  command: string;
  version?: string;
  path?: string;
  error?: string;
}

export interface ArgentNodeStatus {
  version: string;
  major: number;
  supported: boolean;
}

export interface ArgentMcpStatus {
  codexAvailable: boolean;
  registered: boolean;
  command: string;
  rawList?: string;
  error?: string;
}

export interface ArgentDeviceStatus {
  platform: 'ios' | 'android';
  available: boolean;
  command: string;
  devices: string[];
  detail: string;
  error?: string;
}

export interface ArgentMetroStatus {
  running: boolean;
  url: string;
  detail: string;
  error?: string;
}

export type ArgentReadinessLevel = 'pass' | 'warn' | 'fail' | 'unknown';

export interface ArgentReadinessCheck {
  id: string;
  label: string;
  level: ArgentReadinessLevel;
  detail: string;
}

export interface ArgentWorkbenchSnapshot {
  capturedAt: string;
  projectRoot: string;
  mobileProjectPath: string;
  mobileProjectExists: boolean;
  node: ArgentNodeStatus;
  cli: ArgentCliStatus;
  mcp: ArgentMcpStatus;
  ios: ArgentDeviceStatus;
  android: ArgentDeviceStatus;
  metro: ArgentMetroStatus;
  simulatorPreview: SimulatorPreviewStatus;
  checks: ArgentReadinessCheck[];
  commands: ArgentCommandDefinition[];
  prompts: ArgentPromptTemplate[];
}

// ---------------------------------------------------------------------------
// Embedded Editor
// ---------------------------------------------------------------------------

export type EmbeddedEditorMode = 'inspect' | 'browser';
export type EmbeddedEditorAvailability = 'available' | 'unavailable' | 'error';
export type EmbeddedEditorSource = 'chat' | 'cicd' | 'codereview' | 'security' | 'repos' | 'manual';

export interface EmbeddedEditorTarget {
  workspaceId?: string;
  repoId?: string;
  repoName?: string;
  relativePath?: string;
  absolutePath?: string;
  line?: number;
  column?: number;
  source?: EmbeddedEditorSource;
  title?: string;
}

export interface EmbeddedEditorStatus {
  availability: EmbeddedEditorAvailability;
  mode: EmbeddedEditorMode;
  running: boolean;
  provider?: 'code-server' | 'vscode-web';
  command?: string;
  url?: string;
  workspaceId?: string;
  startedAt?: string;
  lastError?: string;
  externalCommand?: 'code' | 'codium' | 'cursor';
}

export interface EmbeddedEditorFileSnapshot {
  kind: 'text' | 'missing' | 'binary';
  absolutePath?: string;
  relativePath?: string;
  fileName?: string;
  repoId?: string;
  repoName?: string;
  content: string;
  totalLines: number;
  displayStartLine: number;
  displayEndLine: number;
  focusLine?: number;
  focusColumn?: number;
  truncated: boolean;
  message?: string;
}

export interface EmbeddedEditorFocusResult {
  status: EmbeddedEditorStatus;
  snapshot: EmbeddedEditorFileSnapshot | null;
  resolvedTarget?: EmbeddedEditorTarget & {
    repoPath?: string;
  };
}

// ---------------------------------------------------------------------------
// Git Client
// ---------------------------------------------------------------------------

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted';

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  oldPath?: string; // for renames
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  tracking?: string; // e.g. "origin/main"
}

export interface GitWorkspaceRepoStatus {
  repoId: string;
  repoName: string;
  branch: string;
  fileCount: number;
  stagedCount: number;
  unstagedCount: number;
}

export interface GitWorkspaceStatus {
  repos: GitWorkspaceRepoStatus[];
  totalFiles: number;
}

export interface GitPullRequestCreateResult {
  repoId: string;
  repoName: string;
  branch: string;
  baseBranch: string;
  commitHash?: string;
  commitMessage: string;
  pullRequestUrl?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs?: string; // branch/tag decorations
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  lastCommit?: string;
  tracking?: string;
}

export interface GitDiffResult {
  filePath: string;
  oldContent: string;
  newContent: string;
  hunks: string; // raw unified diff
}

export type {
  DesignMode,
  FigmaRefKind,
  FigmaFileRef,
  DesignReadiness,
  ChatStartOptions,
} from './design-types.js';

// ---------------------------------------------------------------------------
// Delivery Lifecycle (re-export)
// ---------------------------------------------------------------------------

export type {
  LifecycleStage,
  LifecycleStageDefinition,
  LifecycleStageUpdate,
  GateId,
  GateCriterionType,
  LifecycleItem,
  GateCriterion,
  GateTemplate,
  GateTemplateUpdate,
  GateDecisionOutcome,
  GateDecision,
  AffectedModule,
  ImpactAnalysisScopeType,
  ImpactAnalysis,
  HandoverSection,
  HandoverPack,
  ReadinessStatus,
  OverallReadiness,
  CriterionResult,
  GateReadinessResult,
  AnalysisProgress,
  HandoverProgress,
} from './lifecycle-types.js';

export { DEFAULT_LIFECYCLE_STAGES, GATE_IDS, getGateFallbackLabel } from './lifecycle-types.js';
