import type {
  PentestScan,
  PentestFinding,
  PentestScanConfig,
  PentestScanEvent,
  DockerStatus,
} from './pentest-types';
import type { RunCommand, RunStatus } from './run-types';
import type {
  Iteration,
  AutomationDaemonStatus,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
  AutomationRunEvent,
  AppSettings,
  BaFinding,
  BaFindingStatus,
  BaFindingType,
  BaMessage,
  BaRepoLink,
  BaSession,
  ChatAttachment,
  ChatAttachmentInput,
  ChatFileMentionSearchInput,
  ChatFileMentionSearchResult,
  ChatGoalSnapshot,
  ChatTurnSummary,
  BrowserBridgeStatus,
  ChatMessage,
  ChatPlanSnapshot,
  ChatSendOptions,
  ChatThread,
  ChatStartOptions,
  CicdCreatePipelineInput,
  CicdCreatePipelineResult,
  CicdPipelineAnalysis,
  CodeReview,
  CodeReviewFinding,
  CodeReviewMode,
  CodeReviewPullRequest,
  CodeReviewPullRequestComment,
  CodeReviewScopeRef,
  CodeReviewScopeType,
  CodexMcpRegisterInput,
  CodexRegistryActionResult,
  CodexRegistrySnapshot,
  CodexSkillInstallInput,
  CodexSkillSearchResult,
  CodexEvent,
  CodexSession,
  DocPage,
  DesignReadiness,
  ComplianceDocType,
  ComplianceDocument,
  DevServerTarget,
  DiagnosticsSnapshot,
  EmbeddedEditorFocusResult,
  EmbeddedEditorStatus,
  EmbeddedEditorTarget,
  DbInsightAnalysis,
  DbInsightArtifact,
  DependencyAuditResult,
  DependencyRecord,
  DiagramFile,
  GitStatusResult,
  GitLogEntry,
  GitBranchInfo,
  GitDiffResult,
  GitPullRequestCreateResult,
  GitWorkspaceStatus,
  GovernanceBoard,
  GovernanceDocument,
  OpenInAnvilLaunchIntent,
  OnboardDetection,
  RemoteRepo,
  RepoAdrs,
  Workspace,
  WorkspacePreferences,
  WorkspaceWithRepos,
  WorkspaceSummary,
  Persona,
  RepoInfo,
  RepoIndexProgress,
  RepoSummary,
  SecurityAudit,
  SecurityFinding,
  WorkItem,
  WorkItemCreateInput,
  WorkItemFilters,
  WorkItemProvider,
  WorkspaceCreateOptions,
  WorkspaceScaffoldMaybeCompleteResult,
  WorkspaceScaffoldSession,
  WorkspaceScaffoldStartResult,
  LifecycleItem,
  LifecycleStage,
  LicenseAuditResult,
  MobileCompanionDevice,
  MobileCompanionStatus,
  MobilePairingTicket,
  WorkspaceNote,
  WorkspaceNoteCreateInput,
  RaycastCompanionToken,
  GateId,
  GateTemplate,
  GateTemplateUpdate,
  GateDecision,
  GateDecisionOutcome,
  GateReadinessResult,
  ImpactAnalysis,
  HandoverPack,
  SbomFormat,
} from './types';
import type { Brand } from './branding';

export interface AnvilAPI {
  appWindow: {
    getChromeState: () => Promise<{ isFullScreen: boolean }>;
    onChromeStateChanged: (callback: (state: { isFullScreen: boolean }) => void) => () => void;
  };

  diagnostics: {
    getSnapshot: () => Promise<DiagnosticsSnapshot>;
  };

  mobileCompanion: {
    getStatus: () => Promise<MobileCompanionStatus>;
    setEnabled: (enabled: boolean) => Promise<MobileCompanionStatus>;
    createPairingTicket: () => Promise<MobilePairingTicket>;
    createRaycastToken: () => Promise<RaycastCompanionToken>;
    listDevices: () => Promise<MobileCompanionDevice[]>;
    revokeDevice: (deviceId: string) => Promise<void>;
  };

  workspaceNotes: {
    list: (workspaceId?: string, includeReviewed?: boolean) => Promise<WorkspaceNote[]>;
    create: (input: WorkspaceNoteCreateInput) => Promise<WorkspaceNote>;
    accept: (noteId: string) => Promise<void>;
    dismiss: (noteId: string) => Promise<void>;
  };

  repo: {
    list: () => Promise<RepoInfo[]>;
    connect: (repoPath: string) => Promise<RepoInfo>;
    index: (repoId: string) => Promise<void>;
    getStatus: (repoId: string) => Promise<RepoInfo['status']>;
    resetStatus: (repoId: string) => Promise<void>;
    getSummary: (repoId: string) => Promise<RepoSummary | null>;
    getArchitecture: (repoId: string) => Promise<string | null>;
    selectDirectory: () => Promise<string | null>;
    onIndexProgress: (callback: (data: RepoIndexProgress) => void) => () => void;
    openInVSCode: (repoPath: string) => Promise<void>;
    scan: (folderPath: string, maxDepth?: number) => Promise<Array<{ path: string; name: string }>>;
    onScanProgress: (callback: (data: { path: string; name: string }) => void) => () => void;
    cancelScan: () => Promise<void>;
    ghAuthStatus: () => Promise<{ authenticated: boolean; username?: string; error?: string }>;
    listGithubRepos: () => Promise<RemoteRepo[]>;
    listAdoRepos: () => Promise<RemoteRepo[]>;
    clone: (cloneUrl: string, targetDir: string, provider: 'github' | 'ado') => Promise<string>;
    onCloneProgress: (
      callback: (data: { repoName: string; cloneUrl: string; message: string }) => void,
    ) => () => void;
  };

  chat: {
    startSession: (
      repoIds: string[],
      personaId: string,
      options?: ChatStartOptions,
    ) => Promise<CodexSession>;
    startScaffoldSession: (
      workspaceId: string,
      rootPath: string,
      personaId: string,
    ) => Promise<CodexSession>;
    send: (
      sessionId: string,
      message: string,
      attachments?: ChatAttachment[],
      options?: ChatSendOptions,
    ) => Promise<void>;
    onEvent: (callback: (event: CodexEvent) => void) => () => void;
    stopSession: (sessionId: string) => Promise<void>;
    interrupt: (sessionId: string) => Promise<void>;
    resolveApproval: (
      sessionId: string,
      requestId: string | number,
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    ) => Promise<void>;
    switchPersona: (repoId: string, personaId: string) => Promise<CodexSession>;
    getPersonas: () => Promise<Persona[]>;
    getSessionStatus: (sessionId: string) => Promise<CodexSession['status']>;
    listActiveSessions: () => Promise<CodexSession[]>;
    listTurnSummaries: (threadId: string) => Promise<ChatTurnSummary[]>;
    listThreads: (workspaceId: string | null, personaId: string) => Promise<ChatThread[]>;
    listWorkItemThreads: (workspaceId: string | null) => Promise<ChatThread[]>;
    createThread: (input: {
      workspaceId?: string | null;
      personaId: string;
      title?: string;
      workItemId?: string;
      workItemProvider?: WorkItemProvider;
      workItemTitle?: string;
      repoIds?: string[];
      activeRepoId?: string | null;
    }) => Promise<ChatThread>;
    ensureWorkItemThread: (input: {
      workspaceId?: string | null;
      personaId: string;
      workItemId: string;
      workItemProvider: WorkItemProvider;
      workItemTitle: string;
      repoIds?: string[];
      activeRepoId?: string | null;
    }) => Promise<ChatThread>;
    updateThread: (
      threadId: string,
      updates: {
        title?: string;
        personaId?: string;
        workItemTitle?: string;
        repoIds?: string[];
        activeRepoId?: string | null;
      },
    ) => Promise<ChatThread | null>;
    deleteThread: (threadId: string) => Promise<void>;
    prepareAttachments: (inputs: ChatAttachmentInput[]) => Promise<ChatAttachment[]>;
    selectAttachments: () => Promise<ChatAttachment[]>;
    searchFileMentions: (
      input: ChatFileMentionSearchInput,
    ) => Promise<ChatFileMentionSearchResult[]>;
    saveEntry: (
      threadId: string,
      repoId: string | null,
      sessionId: string | null,
      entry: ChatMessage,
    ) => Promise<void>;
    saveEvent: (
      threadId: string,
      repoId: string | null,
      sessionId: string | null,
      event: CodexEvent,
      timestamp: string,
    ) => Promise<void>;
    loadHistory: (threadId: string) => Promise<ChatMessage[]>;
    clearHistory: (threadId: string) => Promise<void>;
    saveThreadPlan: (threadId: string, plan: ChatPlanSnapshot) => Promise<ChatThread | null>;
    saveThreadGoal: (threadId: string, goal: ChatGoalSnapshot | null) => Promise<ChatThread | null>;
  };

  dbInsights: {
    listArtifacts: (workspaceId: string) => Promise<DbInsightArtifact[]>;
    addArtifact: (workspaceId: string, filePath: string) => Promise<DbInsightArtifact>;
    removeArtifact: (id: string) => Promise<void>;
    selectFiles: () => Promise<string[]>;
    analyze: (workspaceId: string) => Promise<DbInsightAnalysis>;
    getLatestAnalysis: (workspaceId: string) => Promise<DbInsightAnalysis | null>;
  };

  automations: {
    list: (workspaceId: string) => Promise<AutomationDefinition[]>;
    get: (automationId: string) => Promise<AutomationDefinition | null>;
    create: (
      workspaceId: string,
      input: AutomationDefinitionInput,
    ) => Promise<AutomationDefinition>;
    update: (
      automationId: string,
      input: AutomationDefinitionInput,
    ) => Promise<AutomationDefinition | null>;
    remove: (automationId: string) => Promise<void>;
    runNow: (automationId: string) => Promise<AutomationRun>;
    listRuns: (automationId: string) => Promise<AutomationRun[]>;
    getRun: (runId: string) => Promise<AutomationRun | null>;
    listRunEvents: (runId: string) => Promise<AutomationRunEvent[]>;
    getDaemonStatus: () => Promise<AutomationDaemonStatus>;
    reconcileDaemon: () => Promise<AutomationDaemonStatus>;
  };

  onboard: {
    detect: (repoId: string) => Promise<OnboardDetection>;
    generateAgentsMd: (repoId: string) => Promise<string>;
    generateDevcontainer: (repoId: string) => Promise<string>;
    checkEnvironment: (repoId: string) => Promise<OnboardDetection['environmentStatus']>;
    readArtifact: (repoId: string, artifactType: string) => Promise<string | null>;
    writeArtifact: (repoId: string, artifactType: string, content: string) => Promise<void>;
    writeAndCommit: (
      repoId: string,
      artifactType: string,
      content: string,
      commitMessage: string,
    ) => Promise<void>;
    installDep: (command: string) => Promise<{ success: boolean; error?: string }>;
    onInstallOutput: (callback: (line: string) => void) => () => void;
  };

  workitems: {
    list: (filters?: WorkItemFilters) => Promise<WorkItem[]>;
    get: (id: string) => Promise<WorkItem>;
    plan: (id: string) => Promise<string>;
    generateFixPrompt: (id: string) => Promise<string>;
    listIterations: () => Promise<Iteration[]>;
    search: (query: string) => Promise<WorkItem[]>;
  };

  security: {
    runAudit: (repoId: string) => Promise<SecurityAudit>;
    getAudit: (auditId: string) => Promise<SecurityAudit | null>;
    getRunningAudit: (repoId: string) => Promise<SecurityAudit | null>;
    listAudits: (repoId: string) => Promise<SecurityAudit[]>;
    getFindings: (auditId: string) => Promise<SecurityFinding[]>;
    dismissFinding: (findingId: string) => Promise<void>;
    createWorkItem: (findingId: string) => Promise<string>;
    createWorkItemsBulk: (findingIds: string[]) => Promise<string[]>;
    exportReport: (auditId: string) => Promise<string>;
    onAuditProgress: (
      callback: (data: { repoId: string; message: string; percent: number }) => void,
    ) => () => void;
  };

  pentest: {
    checkDocker(): Promise<DockerStatus>;
    startScan(repoId: string, config: PentestScanConfig): Promise<PentestScan>;
    stopScan(scanId: string): Promise<void>;
    getScan(scanId: string): Promise<PentestScan | null>;
    getRunningScan(repoId: string): Promise<PentestScan | null>;
    listScans(repoId: string): Promise<PentestScan[]>;
    getFindings(scanId: string): Promise<PentestFinding[]>;
    dismissFinding(findingId: string): Promise<void>;
    createWorkItem(findingId: string): Promise<string>;
    createWorkItemsBulk(findingIds: string[]): Promise<string[]>;
    exportReport(scanId: string): Promise<string>;
    onScanEvent(callback: (event: PentestScanEvent) => void): () => void;
  };

  run: {
    detectScripts(repoId: string): Promise<RunCommand[]>;
    detectAllScripts(repoIds: string[]): Promise<Record<string, RunCommand[]>>;
    detectScriptsAi(repoId: string): Promise<RunCommand[]>;
    saveCustomCommand(repoId: string, label: string, command: string): Promise<RunCommand>;
    listSavedCommands(repoId: string): Promise<RunCommand[]>;
    pinCommand(commandId: string): Promise<void>;
    unpinCommand(commandId: string): Promise<void>;
    deleteCommand(commandId: string): Promise<void>;
    start(repoId: string, command: string): Promise<void>;
    stop(repoId: string): Promise<void>;
    getStatus(repoId: string): Promise<RunStatus | null>;
    getOutput(repoId: string): Promise<string>;
    onStarted(callback: (data: { repoId: string; command: string }) => void): () => void;
    onStopped(
      callback: (data: { repoId: string; exitCode: number | null; signal?: string }) => void,
    ): () => void;
  };

  codereview: {
    run: (
      repoId: string,
      mode: CodeReviewMode,
      scopeType: CodeReviewScopeType,
      scopeRef?: CodeReviewScopeRef,
    ) => Promise<CodeReview>;
    get: (reviewId: string) => Promise<CodeReview | null>;
    getRunning: (repoId: string) => Promise<CodeReview | null>;
    list: (repoId: string) => Promise<CodeReview[]>;
    getFindings: (reviewId: string) => Promise<CodeReviewFinding[]>;
    generateFixPrompt: (findingId: string) => Promise<string>;
    generateBulkFixPrompt: (findingIds: string[]) => Promise<string>;
    dismissFinding: (findingId: string) => Promise<void>;
    postFindingToPullRequest: (findingId: string) => Promise<CodeReviewPullRequestComment>;
    postReviewToPullRequest: (reviewId: string) => Promise<CodeReviewPullRequestComment>;
    createWorkItem: (findingId: string) => Promise<string>;
    createWorkItemsBulk: (findingIds: string[]) => Promise<string[]>;
    exportReport: (reviewId: string) => Promise<string>;
    listCommits: (
      repoId: string,
    ) => Promise<
      Array<{ sha: string; shortSha: string; message: string; author: string; date: string }>
    >;
    listBranches: (repoId: string) => Promise<string[]>;
    listPullRequests: (repoId: string) => Promise<CodeReviewPullRequest[]>;
    onProgress: (
      callback: (data: { repoId: string; message: string; percent: number }) => void,
    ) => () => void;
  };

  ba: {
    startSession: (
      workItemId: string,
      repoId: string,
    ) => Promise<{ session: BaSession; codexSession: CodexSession }>;
    endSession: (sessionId: string) => Promise<void>;
    listSessions: (workItemId: string) => Promise<BaSession[]>;
    listFindings: (workItemId: string) => Promise<BaFinding[]>;
    createFinding: (finding: {
      workItemId: string;
      repoId: string;
      sessionId?: string;
      type: BaFindingType;
      content: string;
      sourceMessageId?: string;
    }) => Promise<BaFinding>;
    updateFinding: (id: string, updates: { status: BaFindingStatus }) => Promise<void>;
    deleteFinding: (id: string) => Promise<void>;
    createWorkItem: (findingId: string, input: WorkItemCreateInput) => Promise<BaFinding>;
    getRepoLink: (workItemId: string) => Promise<BaRepoLink | null>;
    setRepoLink: (workItemId: string, repoId: string) => Promise<void>;
    saveMessage: (opts: {
      sessionId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      eventType?: string;
    }) => Promise<BaMessage>;
    loadMessages: (sessionId: string) => Promise<BaMessage[]>;
    onSpikeDrift: (callback: (data: { workItemId: string; repoId: string }) => void) => () => void;
    onEvent: (callback: (event: CodexEvent) => void) => () => void;
  };

  adr: {
    /** Scan all repos in a workspace for ADR files */
    listByWorkspace: (workspaceId: string) => Promise<RepoAdrs[]>;
  };

  docs: {
    listPages: (spaceKey?: string) => Promise<DocPage[]>;
    listChildren: (pageId: string) => Promise<DocPage[]>;
    checkStaleness: (pageId: string, repoId: string) => Promise<DocPage['staleness']>;
    generateUpdate: (pageId: string, repoId: string) => Promise<string>;
    createPage: (spaceKey: string, title: string, repoId: string) => Promise<string>;
  };

  settings: {
    get: () => Promise<AppSettings>;
    update: (settings: Partial<AppSettings>) => Promise<void>;
    testFoundryConnection: () => Promise<{ ok: boolean; error?: string }>;
    testAppleFoundationModels: () => Promise<{ ok: boolean; error?: string }>;
    testWorkItemProviderConnection: () => Promise<{ ok: boolean; error?: string }>;
    listLinearTeams: () => Promise<Array<{ id: string; name: string; key: string }>>;
    testConfluenceConnection: () => Promise<{ ok: boolean; error?: string }>;
    testDocsProviderConnection: () => Promise<{ ok: boolean; error?: string }>;
    testGitConnection: () => Promise<{ ok: boolean; error?: string }>;
    getNotionMcpStatus: () => Promise<{ installed: boolean; error?: string }>;
    installNotionMcp: () => Promise<{ success: boolean; error?: string }>;
    startNotionOAuthFlow: () => Promise<{ authUrl: string; state: string; error?: string }>;
    exchangeNotionOAuthCode: (code: string) => Promise<{ success: boolean; error?: string }>;
    resetOnboarding: () => Promise<{ success: boolean; error?: string }>;
  };

  codexRegistry: {
    snapshot: () => Promise<CodexRegistrySnapshot>;
    searchSkills: (query: string) => Promise<CodexSkillSearchResult[]>;
    installSkill: (input: CodexSkillInstallInput) => Promise<CodexRegistryActionResult>;
    registerMcp: (input: CodexMcpRegisterInput) => Promise<CodexRegistryActionResult>;
  };

  diagrams: {
    list: (repoId: string) => Promise<DiagramFile[]>;
    read: (repoId: string, filename: string) => Promise<DiagramFile | null>;
    write: (repoId: string, filename: string, xml: string) => Promise<void>;
    delete: (repoId: string, filename: string) => Promise<void>;
    generate: (
      repoId: string,
      context: string,
      existingXml?: string,
    ) => Promise<{ title: string; drawioXml: string }>;
    cancelGenerate: () => Promise<void>;
    initialize: (repoId: string) => Promise<DiagramFile[]>;
    dirExists: (repoId: string) => Promise<boolean>;
    openEditor: (repoId: string, filename: string) => Promise<void>;
    checkDrawio: () => Promise<{ available: boolean }>;
  };

  workspace: {
    list: () => Promise<WorkspaceSummary[]>;
    get: (id: string) => Promise<WorkspaceWithRepos>;
    getPreferences: (id: string) => Promise<WorkspacePreferences | null>;
    create: (opts: WorkspaceCreateOptions) => Promise<Workspace>;
    update: (id: string, opts: { name: string }) => Promise<Workspace>;
    delete: (id: string) => Promise<void>;
    addRepos: (workspaceId: string, repoIds: string[]) => Promise<void>;
    removeRepos: (workspaceId: string, repoIds: string[]) => Promise<void>;
    updatePreferences: (
      workspaceId: string,
      updates: {
        workitems?: Record<string, unknown>;
        docs?: Record<string, unknown>;
        launch?: Record<string, unknown>;
      },
    ) => Promise<WorkspacePreferences>;
    clearPreferences: (
      workspaceId: string,
      sections?: Array<'workitems' | 'docs' | 'launch'>,
    ) => Promise<WorkspacePreferences>;
    exportVSCodeWorkspace: (workspaceId: string) => Promise<void>;
    openInNewWindow: (workspaceId: string) => Promise<void>;
  };

  workspaceScaffold: {
    start: (workspaceId: string, rootPath: string) => Promise<WorkspaceScaffoldStartResult>;
    getByWorkspace: (workspaceId: string) => Promise<WorkspaceScaffoldSession | null>;
    maybeComplete: (
      workspaceId: string,
      assistantMessage: string,
    ) => Promise<WorkspaceScaffoldMaybeCompleteResult>;
    cancel: (workspaceId: string) => Promise<void>;
  };

  launch: {
    getPendingIntent: () => Promise<OpenInAnvilLaunchIntent | null>;
    clearPendingIntent: () => Promise<void>;
    onIntent: (callback: (intent: OpenInAnvilLaunchIntent) => void) => () => void;
  };

  design: {
    checkReadiness: () => Promise<DesignReadiness>;
    registerFigmaMcp: () => Promise<{ success: boolean; error?: string }>;
    installFrontendSkill: () => Promise<{ success: boolean; error?: string }>;
  };

  terminal: {
    create(workspaceId: string, repoId: string, cwd: string): Promise<{ terminalId: string }>;
    input(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    close(terminalId: string): Promise<void>;
    closeAll(): Promise<void>;
    onData(callback: (data: { terminalId: string; data: string }) => void): () => void;
    onExit(callback: (data: { terminalId: string; exitCode: number }) => void): () => void;
  };

  browser: {
    listTargets(): Promise<DevServerTarget[]>;
    addTarget(url: string): Promise<DevServerTarget>;
    getBridgeStatus(): Promise<BrowserBridgeStatus>;
    startBridge(): Promise<{ port: number }>;
    stopBridge(): Promise<void>;
    attachDebugger(): Promise<void>;
    setUrl(url: string): Promise<void>;
    registerMcp(): Promise<{ success: boolean; error?: string }>;
    onTargetDetected(callback: (target: DevServerTarget) => void): () => void;
  };

  editor: {
    getStatus(): Promise<EmbeddedEditorStatus>;
    start(workspaceId: string): Promise<EmbeddedEditorStatus>;
    stop(): Promise<void>;
    focusTarget(
      target: EmbeddedEditorTarget,
      options?: { startServer?: boolean },
    ): Promise<EmbeddedEditorFocusResult>;
    openExternal(target: EmbeddedEditorTarget): Promise<void>;
  };

  git: {
    status(repoId: string): Promise<GitStatusResult>;
    workspaceStatus(repoIds: string[]): Promise<GitWorkspaceStatus>;
    stage(repoId: string, paths: string[]): Promise<void>;
    unstage(repoId: string, paths: string[]): Promise<void>;
    discard(repoId: string, paths: string[]): Promise<void>;
    commit(repoId: string, message: string): Promise<string>;
    generateCommitMessage(repoId: string): Promise<string>;
    createPullRequest(repoId: string): Promise<GitPullRequestCreateResult>;
    push(repoId: string, remote?: string, branch?: string, setUpstream?: boolean): Promise<string>;
    pull(repoId: string, remote?: string, branch?: string): Promise<string>;
    fetch(repoId: string, remote?: string): Promise<void>;
    log(repoId: string, count?: number): Promise<GitLogEntry[]>;
    branches(repoId: string): Promise<GitBranchInfo[]>;
    createBranch(repoId: string, name: string, startPoint?: string): Promise<void>;
    switchBranch(repoId: string, name: string): Promise<void>;
    deleteBranch(repoId: string, name: string, force?: boolean): Promise<void>;
    diff(repoId: string, filePath: string, staged: boolean): Promise<GitDiffResult>;
    merge(repoId: string, branch: string): Promise<string>;
  };

  cicd: {
    analyze(repoId: string): Promise<CicdPipelineAnalysis>;
    createPipeline(
      repoId: string,
      input: CicdCreatePipelineInput,
    ): Promise<CicdCreatePipelineResult>;
  };

  voice: {
    startListening(): Promise<{ success: boolean; error?: string }>;
    stopListening(): Promise<{ success: boolean; error?: string }>;
    getStatus(): Promise<{ isListening: boolean }>;
    onResult(callback: (text: string) => void): () => void;
    onError(callback: (error: string) => void): () => void;
    onStatus(callback: (status: 'listening' | 'stopped' | 'error') => void): () => void;
  };

  dependencies: {
    list: (repoId: string) => Promise<DependencyRecord[]>;
    audit: (repoId: string, manager: DependencyRecord['manager']) => Promise<DependencyAuditResult>;
    auditLicenses: (repoId: string) => Promise<LicenseAuditResult>;
    exportSbom: (repoId: string, format: SbomFormat) => Promise<string>;
  };

  compliance: {
    generate(repoId: string, docType: ComplianceDocType): Promise<ComplianceDocument>;
    list(repoId: string): Promise<ComplianceDocument[]>;
    read(repoId: string, docType: ComplianceDocType): Promise<ComplianceDocument | null>;
    onProgress(
      callback: (data: {
        repoId: string;
        docType: ComplianceDocType;
        message: string;
        percent: number;
      }) => void,
    ): () => void;
  };

  governance: {
    listBoards(workspaceId: string): Promise<GovernanceBoard[]>;
    createBoard(workspaceId: string, name: string, description?: string): Promise<GovernanceBoard>;
    updateBoard(
      id: string,
      opts: { name?: string; description?: string },
    ): Promise<GovernanceBoard>;
    deleteBoard(id: string): Promise<void>;
    listDocuments(workspaceId: string, boardId?: string): Promise<GovernanceDocument[]>;
    addDocument(
      workspaceId: string,
      filePath: string,
      boardId?: string,
      description?: string,
    ): Promise<GovernanceDocument>;
    updateDocument(
      id: string,
      opts: { boardId?: string | null; description?: string },
    ): Promise<GovernanceDocument>;
    removeDocument(id: string): Promise<void>;
    selectFiles(): Promise<string[]>;
  };

  lifecycle: {
    createItem(
      workspaceId: string,
      opts: {
        title: string;
        description?: string;
        changeClassification?: 'major' | 'minor' | 'standard';
        linkedWorkItemId?: string;
        linkedWorkItemProvider?: WorkItemProvider;
      },
    ): Promise<LifecycleItem>;
    updateItem(
      id: string,
      opts: Partial<
        Pick<LifecycleItem, 'title' | 'description' | 'stage' | 'changeClassification'>
      > & {
        linkedWorkItemId?: string | null;
        linkedWorkItemProvider?: WorkItemProvider | null;
      },
    ): Promise<LifecycleItem>;
    deleteItem(id: string): Promise<void>;
    getItem(id: string): Promise<LifecycleItem | null>;
    listItems(workspaceId: string, filters?: { stage?: LifecycleStage }): Promise<LifecycleItem[]>;
    linkRepos(lifecycleItemId: string, repoIds: string[]): Promise<void>;
    unlinkRepo(lifecycleItemId: string, repoId: string): Promise<void>;
    getGateTemplates(workspaceId: string): Promise<GateTemplate[]>;
    updateGateTemplate(
      workspaceId: string,
      gate: GateId,
      updates: GateTemplateUpdate,
    ): Promise<GateTemplate>;
    resetGateTemplates(workspaceId: string): Promise<GateTemplate[]>;
    checkReadiness(lifecycleItemId: string, gate: GateId): Promise<GateReadinessResult>;
    recordGateDecision(
      lifecycleItemId: string,
      opts: {
        gate: GateId;
        decision: GateDecisionOutcome;
        decidedBy: string;
        conditions?: string;
        rationale?: string;
      },
    ): Promise<GateDecision>;
    listGateDecisions(lifecycleItemId: string): Promise<GateDecision[]>;
    runImpactAnalysis(
      lifecycleItemId: string,
      opts: {
        scopeType: string;
        scopeRef?: string;
      },
    ): Promise<ImpactAnalysis>;
    getImpactAnalysis(id: string): Promise<ImpactAnalysis | null>;
    listImpactAnalyses(lifecycleItemId: string): Promise<ImpactAnalysis[]>;
    generateHandoverPack(lifecycleItemId: string): Promise<HandoverPack>;
    listHandoverPacks(lifecycleItemId: string): Promise<HandoverPack[]>;
    exportHandoverPack(packId: string): Promise<string>;
    onAnalysisProgress(
      callback: (data: { lifecycleItemId: string; message: string; percent: number }) => void,
    ): () => void;
    onHandoverProgress(
      callback: (data: {
        lifecycleItemId: string;
        section: string;
        message: string;
        percent: number;
      }) => void,
    ): () => void;
  };
}

export interface BrandAPI {
  get: () => Promise<Brand>;
}

declare global {
  interface Window {
    anvil: AnvilAPI;
    devhub: AnvilAPI;
    brand: BrandAPI;
  }
}
