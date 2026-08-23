import { contextBridge, ipcRenderer } from 'electron';
import type { AnvilAPI } from '../shared/ipc-api.js';
import type {
  AutomationDaemonStatus,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
  AutomationRunEvent,
  AutomationTriageItem,
  ArgentCommandId,
  ChatArtifactInput,
  ChatArtifactAnnotationInput,
  ChatArtifactAnnotationPatch,
  ChatAttachment,
  ChatNavigationTarget,
  ChatAttachmentInput,
  ChatFileMentionSearchInput,
  ChatMessage,
  ChatGoalSnapshot,
  ChatPlanSnapshot,
  ChatSendOptions,
  CodexInputResponse,
  CodeReviewMode,
  CodeReviewScopeRef,
  CodeReviewScopeType,
  ComplianceDocType,
  DevServerTarget,
  EmbeddedEditorTarget,
  SimulatorPreviewStartOptions,
  GateId,
  GateTemplateUpdate,
  CodexUsageSnapshot,
  RepoIndexProgress,
  TerminalClosedEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  WorkItemProvider,
  WorkspaceCreateOptions,
} from '../shared/types.js';
import type { PentestScanConfig, PentestScanEvent } from '../shared/pentest-types.js';
import type { RunCommand, RunStatus } from '../shared/run-types.js';
import type {
  AgentUIIntentPresentationPatch,
  AgentUIPlanPatch,
  AgentUIQuestionResolution,
} from '../shared/agent-ui-intents.js';

const api: AnvilAPI = {
  appWindow: {
    getVersion: () => ipcRenderer.invoke('app-window:get-version'),
    getChromeState: () => ipcRenderer.invoke('app-window:get-chrome-state'),
    onChromeStateChanged: (callback: (state: { isFullScreen: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: { isFullScreen: boolean }) =>
        callback(state);
      ipcRenderer.on('app-window:chrome-state-changed', handler);
      return () => ipcRenderer.removeListener('app-window:chrome-state-changed', handler);
    },
    onNavigateToChat: (callback: (target: ChatNavigationTarget) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, target: ChatNavigationTarget) =>
        callback(target);
      ipcRenderer.on('app-window:navigate-to-chat', handler);
      return () => ipcRenderer.removeListener('app-window:navigate-to-chat', handler);
    },
  },

  diagnostics: {
    getSnapshot: () => ipcRenderer.invoke('diagnostics:get-snapshot'),
  },

  mobileCompanion: {
    getStatus: () => ipcRenderer.invoke('mobile-companion:get-status'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('mobile-companion:set-enabled', enabled),
    createPairingTicket: () => ipcRenderer.invoke('mobile-companion:create-pairing-ticket'),
    createRaycastToken: () => ipcRenderer.invoke('mobile-companion:create-raycast-token'),
    listDevices: () => ipcRenderer.invoke('mobile-companion:list-devices'),
    revokeDevice: (deviceId: string) =>
      ipcRenderer.invoke('mobile-companion:revoke-device', deviceId),
  },

  workspaceNotes: {
    list: (workspaceId?: string, includeReviewed?: boolean) =>
      ipcRenderer.invoke('workspace-notes:list', workspaceId, includeReviewed),
    create: (input) => ipcRenderer.invoke('workspace-notes:create', input),
    accept: (noteId: string) => ipcRenderer.invoke('workspace-notes:accept', noteId),
    dismiss: (noteId: string) => ipcRenderer.invoke('workspace-notes:dismiss', noteId),
  },

  repo: {
    list: () => ipcRenderer.invoke('repo:list'),
    connect: (repoPath: string) => ipcRenderer.invoke('repo:connect', repoPath),
    index: (repoId: string) => ipcRenderer.invoke('repo:index', repoId),
    getStatus: (repoId: string) => ipcRenderer.invoke('repo:status', repoId),
    resetStatus: (repoId: string) => ipcRenderer.invoke('repo:reset-status', repoId),
    getSummary: (repoId: string) => ipcRenderer.invoke('repo:summary', repoId),
    getMapStatus: (repoId: string) => ipcRenderer.invoke('repo:map-status', repoId),
    getMapGraph: (repoId: string) => ipcRenderer.invoke('repo:map-graph', repoId),
    setMapRefreshMode: (repoId: string, refreshMode: 'manual' | 'on_commit') =>
      ipcRenderer.invoke('repo:set-map-refresh-mode', repoId, refreshMode),
    getArchitecture: (repoId: string) => ipcRenderer.invoke('repo:architecture', repoId),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    openInVSCode: (repoPath: string) => ipcRenderer.invoke('repo:open-vscode', repoPath),
    onIndexProgress: (callback: (data: RepoIndexProgress) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: RepoIndexProgress) => callback(data);
      ipcRenderer.on('repo:index-progress', handler);
      return () => ipcRenderer.removeListener('repo:index-progress', handler);
    },
    scan: (folderPath: string, maxDepth?: number) =>
      ipcRenderer.invoke('repo:scan', folderPath, maxDepth),
    onScanProgress: (callback: (data: { path: string; name: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { path: string; name: string }) =>
        callback(data);
      ipcRenderer.on('repo:scan-progress', handler);
      return () => ipcRenderer.removeListener('repo:scan-progress', handler);
    },
    cancelScan: () => ipcRenderer.invoke('repo:cancel-scan'),
    ghAuthStatus: () =>
      ipcRenderer.invoke('repo:gh-auth-status') as Promise<{
        authenticated: boolean;
        username?: string;
        error?: string;
      }>,
    listGithubRepos: () => ipcRenderer.invoke('repo:list-github'),
    listAdoRepos: () => ipcRenderer.invoke('repo:list-ado'),
    clone: (cloneUrl: string, targetDir: string, provider: 'github' | 'ado') =>
      ipcRenderer.invoke('repo:clone', cloneUrl, targetDir, provider),
    onCloneProgress: (
      callback: (data: { repoName: string; cloneUrl: string; message: string }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { repoName: string; cloneUrl: string; message: string },
      ) => callback(data);
      ipcRenderer.on('repo:clone-progress', handler);
      return () => ipcRenderer.removeListener('repo:clone-progress', handler);
    },
  },

  chat: {
    startSession: (
      repoIds: string[],
      personaId: string,
      options?: import('../shared/types.js').ChatStartOptions,
    ) => ipcRenderer.invoke('chat:start-session', repoIds, personaId, options),
    startScaffoldSession: (workspaceId: string, rootPath: string, personaId: string) =>
      ipcRenderer.invoke('chat:start-scaffold-session', workspaceId, rootPath, personaId),
    send: (
      sessionId: string,
      message: string,
      attachments?: ChatAttachment[],
      options?: ChatSendOptions,
    ) => ipcRenderer.invoke('chat:send', sessionId, message, attachments, options),
    onEvent: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, event: unknown) =>
        callback(event as Parameters<typeof callback>[0]);
      ipcRenderer.on('chat:event', handler);
      return () => ipcRenderer.removeListener('chat:event', handler);
    },
    stopSession: (sessionId: string) => ipcRenderer.invoke('chat:stop-session', sessionId),
    interrupt: (sessionId: string) => ipcRenderer.invoke('chat:interrupt', sessionId),
    steer: (sessionId: string, message: string, attachments?: ChatAttachment[]) =>
      ipcRenderer.invoke('chat:steer', sessionId, message, attachments),
    forkProviderThread: (sourceThreadId: string, targetThreadId: string) =>
      ipcRenderer.invoke('chat:fork-provider-thread', sourceThreadId, targetThreadId),
    resolveApproval: (
      sessionId: string,
      requestId: string | number,
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    ) => ipcRenderer.invoke('chat:resolve-approval', sessionId, requestId, decision),
    resolveInputRequest: (
      sessionId: string,
      requestId: string | number,
      response: CodexInputResponse,
    ) => ipcRenderer.invoke('chat:resolve-input-request', sessionId, requestId, response),
    switchPersona: (repoId: string, personaId: string) =>
      ipcRenderer.invoke('chat:switch-persona', repoId, personaId),
    getPersonas: () => ipcRenderer.invoke('chat:get-personas'),
    getSessionStatus: (sessionId: string) => ipcRenderer.invoke('chat:session-status', sessionId),
    listActiveSessions: () => ipcRenderer.invoke('chat:list-active-sessions'),
    listTurnSummaries: (threadId: string) =>
      ipcRenderer.invoke('chat:list-turn-summaries', threadId),
    listArtifacts: (threadId: string) => ipcRenderer.invoke('chat:list-artifacts', threadId),
    upsertArtifact: (input: ChatArtifactInput) => ipcRenderer.invoke('chat:upsert-artifact', input),
    discardArtifact: (id: string) => ipcRenderer.invoke('chat:discard-artifact', id),
    readArtifactFile: (id: string) => ipcRenderer.invoke('chat:read-artifact-file', id),
    listArtifactAnnotations: (artifactId: string) =>
      ipcRenderer.invoke('chat:list-artifact-annotations', artifactId),
    createArtifactAnnotation: (input: ChatArtifactAnnotationInput) =>
      ipcRenderer.invoke('chat:create-artifact-annotation', input),
    updateArtifactAnnotation: (id: string, patch: ChatArtifactAnnotationPatch) =>
      ipcRenderer.invoke('chat:update-artifact-annotation', id, patch),
    deleteArtifactAnnotation: (id: string) =>
      ipcRenderer.invoke('chat:delete-artifact-annotation', id),
    listThreads: (workspaceId: string | null) =>
      ipcRenderer.invoke('chat:list-threads', workspaceId),
    listWorkItemThreads: (workspaceId: string | null) =>
      ipcRenderer.invoke('chat:list-work-item-threads', workspaceId),
    createThread: (input: {
      workspaceId?: string | null;
      personaId: string;
      title?: string;
      workItemId?: string;
      workItemProvider?: WorkItemProvider;
      workItemTitle?: string;
      repoIds?: string[];
      activeRepoId?: string | null;
    }) => ipcRenderer.invoke('chat:create-thread', input),
    ensureWorkItemThread: (input: {
      workspaceId?: string | null;
      personaId: string;
      workItemId: string;
      workItemProvider: WorkItemProvider;
      workItemTitle: string;
      repoIds?: string[];
      activeRepoId?: string | null;
    }) => ipcRenderer.invoke('chat:ensure-work-item-thread', input),
    updateThread: (
      threadId: string,
      updates: {
        title?: string;
        personaId?: string;
        workItemTitle?: string;
        repoIds?: string[];
        activeRepoId?: string | null;
        settled?: boolean;
        viewed?: boolean;
      },
    ) => ipcRenderer.invoke('chat:update-thread', threadId, updates),
    deleteThread: (threadId: string) => ipcRenderer.invoke('chat:delete-thread', threadId),
    prepareAttachments: (inputs: ChatAttachmentInput[]) =>
      ipcRenderer.invoke('chat:prepare-attachments', inputs),
    selectAttachments: () => ipcRenderer.invoke('chat:select-attachments'),
    searchFileMentions: (input: ChatFileMentionSearchInput) =>
      ipcRenderer.invoke('chat:search-file-mentions', input),
    saveEntry: (
      threadId: string,
      repoId: string | null,
      sessionId: string | null,
      entry: ChatMessage,
    ) => ipcRenderer.invoke('chat:save-entry', threadId, repoId, sessionId, entry),
    saveEvent: (
      threadId: string,
      repoId: string | null,
      sessionId: string | null,
      event,
      timestamp: string,
    ) => ipcRenderer.invoke('chat:save-event', threadId, repoId, sessionId, event, timestamp),
    loadHistory: (threadId: string) => ipcRenderer.invoke('chat:load-history', threadId),
    clearHistory: (threadId: string) => ipcRenderer.invoke('chat:clear-history', threadId),
    saveThreadPlan: (threadId: string, plan: ChatPlanSnapshot) =>
      ipcRenderer.invoke('chat:save-thread-plan', threadId, plan),
    saveThreadGoal: (threadId: string, goal: ChatGoalSnapshot | null) =>
      ipcRenderer.invoke('chat:save-thread-goal', threadId, goal),
    listAgentUIIntents: (threadId: string, includeInactive = true) =>
      ipcRenderer.invoke('chat:list-agent-ui-intents', threadId, includeInactive),
    resolveAgentUIQuestion: (intentId: string, resolution: AgentUIQuestionResolution) =>
      ipcRenderer.invoke('chat:resolve-agent-ui-question', intentId, resolution),
    patchAgentUIPlan: (intentId: string, patch: AgentUIPlanPatch) =>
      ipcRenderer.invoke('chat:patch-agent-ui-plan', intentId, patch),
    updateAgentUIIntentPresentation: (intentId: string, patch: AgentUIIntentPresentationPatch) =>
      ipcRenderer.invoke('chat:update-agent-ui-presentation', intentId, patch),
    dismissAgentUIIntent: (intentId: string) =>
      ipcRenderer.invoke('chat:dismiss-agent-ui-intent', intentId),
    restoreAgentUIIntent: (intentId: string) =>
      ipcRenderer.invoke('chat:restore-agent-ui-intent', intentId),
  },

  workflow: {
    listTemplates: () => ipcRenderer.invoke('workflow:list-templates'),
    draftTemplate: (request: string) => ipcRenderer.invoke('workflow:draft-template', request),
    saveTemplate: (input: import('../shared/types.js').WorkflowTemplateInput, id?: string) =>
      ipcRenderer.invoke('workflow:save-template', input, id),
    deleteTemplate: (id: string) => ipcRenderer.invoke('workflow:delete-template', id),
    listRuns: (workspaceId: string) => ipcRenderer.invoke('workflow:list-runs', workspaceId),
    getRun: (id: string) => ipcRenderer.invoke('workflow:get-run', id),
    startRun: (input: {
      templateId: string;
      workspaceId: string;
      repoIds: string[];
      kickoff: string;
    }) => ipcRenderer.invoke('workflow:start-run', input),
    askSupervisor: (runId: string, question: string) =>
      ipcRenderer.invoke('workflow:ask-supervisor', runId, question),
    cancelRun: (runId: string) => ipcRenderer.invoke('workflow:cancel-run', runId),
  },

  dbInsights: {
    listArtifacts: (workspaceId: string) =>
      ipcRenderer.invoke('db-insights:list-artifacts', workspaceId),
    addArtifact: (workspaceId: string, filePath: string) =>
      ipcRenderer.invoke('db-insights:add-artifact', workspaceId, filePath),
    removeArtifact: (id: string) => ipcRenderer.invoke('db-insights:remove-artifact', id),
    selectFiles: () => ipcRenderer.invoke('db-insights:select-files'),
    analyze: (workspaceId: string) => ipcRenderer.invoke('db-insights:analyze', workspaceId),
    getLatestAnalysis: (workspaceId: string) =>
      ipcRenderer.invoke('db-insights:get-latest-analysis', workspaceId),
  },

  automations: {
    list: (workspaceId: string) =>
      ipcRenderer.invoke('automations:list', workspaceId) as Promise<AutomationDefinition[]>,
    get: (automationId: string) =>
      ipcRenderer.invoke('automations:get', automationId) as Promise<AutomationDefinition | null>,
    create: (workspaceId: string, input: AutomationDefinitionInput) =>
      ipcRenderer.invoke('automations:create', workspaceId, input) as Promise<AutomationDefinition>,
    update: (automationId: string, input: AutomationDefinitionInput) =>
      ipcRenderer.invoke(
        'automations:update',
        automationId,
        input,
      ) as Promise<AutomationDefinition | null>,
    remove: (automationId: string) =>
      ipcRenderer.invoke('automations:remove', automationId) as Promise<void>,
    runNow: (automationId: string) =>
      ipcRenderer.invoke('automations:run-now', automationId) as Promise<AutomationRun>,
    triage: (workspaceId: string) =>
      ipcRenderer.invoke('automations:triage', workspaceId) as Promise<AutomationTriageItem[]>,
    listRuns: (automationId: string) =>
      ipcRenderer.invoke('automations:list-runs', automationId) as Promise<AutomationRun[]>,
    getRun: (runId: string) =>
      ipcRenderer.invoke('automations:get-run', runId) as Promise<AutomationRun | null>,
    listRunEvents: (runId: string) =>
      ipcRenderer.invoke('automations:list-run-events', runId) as Promise<AutomationRunEvent[]>,
    getDaemonStatus: () =>
      ipcRenderer.invoke('automations:daemon-status') as Promise<AutomationDaemonStatus>,
    reconcileDaemon: () =>
      ipcRenderer.invoke('automations:reconcile-daemon') as Promise<AutomationDaemonStatus>,
  },

  agentRuns: {
    list: (workspaceId: string, limit?: number) =>
      ipcRenderer.invoke('agent-runs:list', workspaceId, limit),
  },

  onboard: {
    detect: (repoId: string) => ipcRenderer.invoke('onboard:detect', repoId),
    generateAgentsMd: (repoId: string) => ipcRenderer.invoke('onboard:agents-md', repoId),
    generateDevcontainer: (repoId: string) => ipcRenderer.invoke('onboard:devcontainer', repoId),
    checkEnvironment: (repoId: string) => ipcRenderer.invoke('onboard:check-env', repoId),
    readArtifact: (repoId: string, artifactType: string) =>
      ipcRenderer.invoke('onboard:read-artifact', repoId, artifactType) as Promise<string | null>,
    writeArtifact: (repoId: string, artifactType: string, content: string) =>
      ipcRenderer.invoke('onboard:write', repoId, artifactType, content),
    writeAndCommit: (
      repoId: string,
      artifactType: string,
      content: string,
      commitMessage: string,
    ) =>
      ipcRenderer.invoke('onboard:write-and-commit', repoId, artifactType, content, commitMessage),
    installDep: (command: string) =>
      ipcRenderer.invoke('onboard:install-dep', command) as Promise<{
        success: boolean;
        error?: string;
      }>,
    onInstallOutput: (callback: (line: string) => void) => {
      const handler = (_event: unknown, line: string) => callback(line);
      ipcRenderer.on('onboard:install-output', handler);
      return () => {
        ipcRenderer.removeListener('onboard:install-output', handler);
      };
    },
  },

  workitems: {
    list: (filters) => ipcRenderer.invoke('workitems:list', filters),
    get: (id: string) => ipcRenderer.invoke('workitems:get', id),
    plan: (id: string) => ipcRenderer.invoke('workitems:plan', id),
    generateFixPrompt: (id: string) => ipcRenderer.invoke('workitems:fix-prompt', id),
    listIterations: () => ipcRenderer.invoke('workitems:iterations'),
    search: (query: string) => ipcRenderer.invoke('workitems:search', query),
  },

  security: {
    runAudit: (repoId: string) => ipcRenderer.invoke('security:run-audit', repoId),
    getAudit: (auditId: string) => ipcRenderer.invoke('security:get-audit', auditId),
    getRunningAudit: (repoId: string) => ipcRenderer.invoke('security:get-running-audit', repoId),
    listAudits: (repoId: string) => ipcRenderer.invoke('security:list-audits', repoId),
    getFindings: (auditId: string) => ipcRenderer.invoke('security:get-findings', auditId),
    dismissFinding: (findingId: string) =>
      ipcRenderer.invoke('security:dismiss-finding', findingId),
    createWorkItem: (findingId: string) =>
      ipcRenderer.invoke('security:create-work-item', findingId),
    createWorkItemsBulk: (findingIds: string[]) =>
      ipcRenderer.invoke('security:create-work-items-bulk', findingIds),
    exportReport: (auditId: string) => ipcRenderer.invoke('security:export-report', auditId),
    onAuditProgress: (
      callback: (data: { repoId: string; message: string; percent: number }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { repoId: string; message: string; percent: number },
      ) => callback(data);
      ipcRenderer.on('security:audit-progress', handler);
      return () => ipcRenderer.removeListener('security:audit-progress', handler);
    },
  },

  pentest: {
    checkDocker: () => ipcRenderer.invoke('pentest:check-docker'),
    startScan: (repoId: string, config: PentestScanConfig) =>
      ipcRenderer.invoke('pentest:start-scan', repoId, config),
    stopScan: (scanId: string) => ipcRenderer.invoke('pentest:stop-scan', scanId),
    getScan: (scanId: string) => ipcRenderer.invoke('pentest:get-scan', scanId),
    getRunningScan: (repoId: string) => ipcRenderer.invoke('pentest:get-running-scan', repoId),
    listScans: (repoId: string) => ipcRenderer.invoke('pentest:list-scans', repoId),
    getFindings: (scanId: string) => ipcRenderer.invoke('pentest:get-findings', scanId),
    dismissFinding: (findingId: string) => ipcRenderer.invoke('pentest:dismiss-finding', findingId),
    createWorkItem: (findingId: string) =>
      ipcRenderer.invoke('pentest:create-work-item', findingId),
    createWorkItemsBulk: (findingIds: string[]) =>
      ipcRenderer.invoke('pentest:create-work-items-bulk', findingIds),
    exportReport: (scanId: string) => ipcRenderer.invoke('pentest:export-report', scanId),
    onScanEvent: (callback: (event: PentestScanEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: PentestScanEvent) => callback(event);
      ipcRenderer.on('pentest:scan-event', handler);
      return () => ipcRenderer.removeListener('pentest:scan-event', handler);
    },
  },

  run: {
    detectScripts: (repoId: string) =>
      ipcRenderer.invoke('run:detect-scripts', repoId) as Promise<RunCommand[]>,
    detectAllScripts: (repoIds: string[]) =>
      ipcRenderer.invoke('run:detect-all-scripts', repoIds) as Promise<
        Record<string, RunCommand[]>
      >,
    detectScriptsAi: (repoId: string) =>
      ipcRenderer.invoke('run:detect-scripts-ai', repoId) as Promise<RunCommand[]>,
    saveCustomCommand: (repoId: string, label: string, command: string) =>
      ipcRenderer.invoke('run:save-custom-command', repoId, label, command) as Promise<RunCommand>,
    listSavedCommands: (repoId: string) =>
      ipcRenderer.invoke('run:list-saved-commands', repoId) as Promise<RunCommand[]>,
    pinCommand: (commandId: string) =>
      ipcRenderer.invoke('run:pin-command', commandId) as Promise<void>,
    unpinCommand: (commandId: string) =>
      ipcRenderer.invoke('run:unpin-command', commandId) as Promise<void>,
    deleteCommand: (commandId: string) =>
      ipcRenderer.invoke('run:delete-command', commandId) as Promise<void>,
    start: (repoId: string, command: string) =>
      ipcRenderer.invoke('run:start', repoId, command) as Promise<void>,
    stop: (repoId: string) => ipcRenderer.invoke('run:stop', repoId) as Promise<void>,
    getStatus: (repoId: string) =>
      ipcRenderer.invoke('run:get-status', repoId) as Promise<RunStatus | null>,
    getOutput: (repoId: string) => ipcRenderer.invoke('run:get-output', repoId) as Promise<string>,
    onStarted: (callback: (data: { repoId: string; command: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { repoId: string; command: string }) =>
        callback(data);
      ipcRenderer.on('run:started', handler);
      return () => ipcRenderer.removeListener('run:started', handler);
    },
    onStopped: (
      callback: (data: { repoId: string; exitCode: number | null; signal?: string }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { repoId: string; exitCode: number | null; signal?: string },
      ) => callback(data);
      ipcRenderer.on('run:stopped', handler);
      return () => ipcRenderer.removeListener('run:stopped', handler);
    },
  },

  codereview: {
    run: (
      repoId: string,
      mode: CodeReviewMode,
      scopeType: CodeReviewScopeType,
      scopeRef?: CodeReviewScopeRef,
    ) => ipcRenderer.invoke('codereview:run', repoId, mode, scopeType, scopeRef),
    get: (reviewId: string) => ipcRenderer.invoke('codereview:get', reviewId),
    getRunning: (repoId: string) => ipcRenderer.invoke('codereview:get-running', repoId),
    list: (repoId: string) => ipcRenderer.invoke('codereview:list', repoId),
    getFindings: (reviewId: string) => ipcRenderer.invoke('codereview:get-findings', reviewId),
    generateFixPrompt: (findingId: string) =>
      ipcRenderer.invoke('codereview:fix-prompt', findingId),
    generateBulkFixPrompt: (findingIds: string[]) =>
      ipcRenderer.invoke('codereview:fix-prompt-bulk', findingIds),
    dismissFinding: (findingId: string) =>
      ipcRenderer.invoke('codereview:dismiss-finding', findingId),
    postFindingToPullRequest: (findingId: string) =>
      ipcRenderer.invoke('codereview:post-finding-to-pr', findingId),
    postReviewToPullRequest: (reviewId: string) =>
      ipcRenderer.invoke('codereview:post-review-to-pr', reviewId),
    createWorkItem: (findingId: string) =>
      ipcRenderer.invoke('codereview:create-work-item', findingId),
    createWorkItemsBulk: (findingIds: string[]) =>
      ipcRenderer.invoke('codereview:create-work-items-bulk', findingIds),
    exportReport: (reviewId: string) => ipcRenderer.invoke('codereview:export-report', reviewId),
    listCommits: (repoId: string) => ipcRenderer.invoke('codereview:list-commits', repoId),
    listBranches: (repoId: string) => ipcRenderer.invoke('codereview:list-branches', repoId),
    listPullRequests: (repoId: string) =>
      ipcRenderer.invoke('codereview:list-pull-requests', repoId),
    visualisePullRequest: (
      repoId: string,
      pullRequestId: string,
      options?: { force?: boolean; reviewId?: string },
    ) => ipcRenderer.invoke('codereview:visualise-pull-request', repoId, pullRequestId, options),
    getPullRequestVisualisation: (repoId: string, pullRequestId: string) =>
      ipcRenderer.invoke('codereview:get-pull-request-visualisation', repoId, pullRequestId),
    exportPullRequestVisualisation: (repoId: string, pullRequestId: string) =>
      ipcRenderer.invoke('codereview:export-pull-request-visualisation', repoId, pullRequestId),
    getPullRequestDiff: (repoId: string, pullRequestId: string) =>
      ipcRenderer.invoke('codereview:get-pull-request-diff', repoId, pullRequestId),
    getChangeSummary: (reviewId: string) =>
      ipcRenderer.invoke('codereview:get-change-summary', reviewId),
    onProgress: (
      callback: (data: { repoId: string; message: string; percent: number }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { repoId: string; message: string; percent: number },
      ) => callback(data);
      ipcRenderer.on('codereview:progress', handler);
      return () => ipcRenderer.removeListener('codereview:progress', handler);
    },
  },

  ba: {
    startSession: (workItemId: string, repoId: string) =>
      ipcRenderer.invoke('ba:sessions:start', workItemId, repoId),
    endSession: (sessionId: string) => ipcRenderer.invoke('ba:sessions:end', sessionId),
    listSessions: (workItemId: string) => ipcRenderer.invoke('ba:sessions:list', workItemId),
    listFindings: (workItemId: string) => ipcRenderer.invoke('ba:findings:list', workItemId),
    createFinding: (finding: Parameters<AnvilAPI['ba']['createFinding']>[0]) =>
      ipcRenderer.invoke('ba:findings:create', finding),
    updateFinding: (
      id: string,
      updates: { status: import('../shared/types.js').BaFindingStatus },
    ) => ipcRenderer.invoke('ba:findings:update', id, updates),
    deleteFinding: (id: string) => ipcRenderer.invoke('ba:findings:delete', id),
    createWorkItem: (findingId: string, input: import('../shared/types.js').WorkItemCreateInput) =>
      ipcRenderer.invoke('ba:findings:create-work-item', findingId, input),
    getRepoLink: (workItemId: string) => ipcRenderer.invoke('ba:repo-links:get', workItemId),
    setRepoLink: (workItemId: string, repoId: string) =>
      ipcRenderer.invoke('ba:repo-links:set', workItemId, repoId),
    saveMessage: (opts: Parameters<AnvilAPI['ba']['saveMessage']>[0]) =>
      ipcRenderer.invoke('ba:messages:save', opts),
    loadMessages: (sessionId: string) => ipcRenderer.invoke('ba:messages:load', sessionId),
    onSpikeDrift: (callback: (data: { workItemId: string; repoId: string }) => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { workItemId: string; repoId: string },
      ) => callback(data);
      ipcRenderer.on('ba:spike-drift', handler);
      return () => ipcRenderer.removeListener('ba:spike-drift', handler);
    },
    onEvent: (callback: (event: import('../shared/types.js').CodexEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: unknown) =>
        callback(event as import('../shared/types.js').CodexEvent);
      ipcRenderer.on('chat:event', handler);
      return () => ipcRenderer.removeListener('chat:event', handler);
    },
  },

  adr: {
    listByWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke('adr:list-by-workspace', workspaceId),
  },

  docs: {
    listPages: (spaceKey?: string) => ipcRenderer.invoke('docs:list', spaceKey),
    listChildren: (pageId: string) => ipcRenderer.invoke('docs:list-children', pageId),
    checkStaleness: (pageId: string, repoId: string) =>
      ipcRenderer.invoke('docs:check-stale', pageId, repoId),
    generateUpdate: (pageId: string, repoId: string) =>
      ipcRenderer.invoke('docs:generate-update', pageId, repoId),
    createPage: (spaceKey: string, title: string, repoId: string) =>
      ipcRenderer.invoke('docs:create', spaceKey, title, repoId),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (settings) => ipcRenderer.invoke('settings:update', settings),
    getCodexStatus: () => ipcRenderer.invoke('settings:codex-status'),
    getCursorStatus: () => ipcRenderer.invoke('settings:cursor-status'),
    setCodexAgentMaxThreads: (maxThreads) =>
      ipcRenderer.invoke('settings:codex-agent-max-threads', maxThreads),
    testFoundryConnection: () => ipcRenderer.invoke('settings:test-foundry'),
    testAppleFoundationModels: () => ipcRenderer.invoke('settings:test-apple-foundation-models'),
    testWorkItemProviderConnection: () => ipcRenderer.invoke('settings:test-workitem-provider'),
    listLinearTeams: () => ipcRenderer.invoke('settings:linear-teams'),
    testConfluenceConnection: () => ipcRenderer.invoke('settings:test-confluence'),
    testDocsProviderConnection: () => ipcRenderer.invoke('settings:test-docs-provider'),
    testGitConnection: () => ipcRenderer.invoke('settings:test-git'),
    getNotionMcpStatus: () => ipcRenderer.invoke('settings:notion-mcp-status'),
    installNotionMcp: () => ipcRenderer.invoke('settings:notion-mcp-install'),
    startNotionOAuthFlow: () => ipcRenderer.invoke('settings:notion-oauth-start'),
    exchangeNotionOAuthCode: (code: string) =>
      ipcRenderer.invoke('settings:notion-oauth-exchange', code),
    getCodexAgentsFile: () => ipcRenderer.invoke('settings:codex-agents:get'),
    saveCodexAgentsFile: (content: string) =>
      ipcRenderer.invoke('settings:codex-agents:save', content),
    resetOnboarding: () => ipcRenderer.invoke('settings:reset-onboarding'),
  },

  codexRegistry: {
    snapshot: () => ipcRenderer.invoke('codex-registry:snapshot'),
    searchSkills: (query: string) => ipcRenderer.invoke('codex-registry:search-skills', query),
    installSkill: (input) => ipcRenderer.invoke('codex-registry:install-skill', input),
    registerMcp: (input) => ipcRenderer.invoke('codex-registry:register-mcp', input),
  },

  codexUsage: {
    snapshot: () => ipcRenderer.invoke('codex-usage:snapshot') as Promise<CodexUsageSnapshot>,
  },

  anvilCloud: {
    snapshot: () => ipcRenderer.invoke('anvil-cloud:snapshot'),
    run: (commandId, cwd) => ipcRenderer.invoke('anvil-cloud:run', commandId, cwd),
    openLens: (cwd) => ipcRenderer.invoke('anvil-cloud:open-lens', cwd),
    executionConnection: () => ipcRenderer.invoke('anvil-cloud:execution-connection'),
    saveExecutionConnection: (input) =>
      ipcRenderer.invoke('anvil-cloud:save-execution-connection', input),
    clearExecutionConnection: () => ipcRenderer.invoke('anvil-cloud:clear-execution-connection'),
    testExecutionConnection: () => ipcRenderer.invoke('anvil-cloud:test-execution-connection'),
    listExecutions: () => ipcRenderer.invoke('anvil-cloud:executions-list'),
    getExecution: (executionId) => ipcRenderer.invoke('anvil-cloud:execution-get', executionId),
    startExecution: (input) => ipcRenderer.invoke('anvil-cloud:execution-start', input),
    executionEvents: (executionId, cursor) =>
      ipcRenderer.invoke('anvil-cloud:execution-events', executionId, cursor),
    resolveExecutionApproval: (input) =>
      ipcRenderer.invoke('anvil-cloud:execution-approval', input),
    steerExecution: (executionId, message) =>
      ipcRenderer.invoke('anvil-cloud:execution-steer', executionId, message),
    collectExecution: (executionId) =>
      ipcRenderer.invoke('anvil-cloud:execution-collect', executionId),
    terminateExecution: (executionId) =>
      ipcRenderer.invoke('anvil-cloud:execution-terminate', executionId),
  },

  diagrams: {
    list: (repoId: string) => ipcRenderer.invoke('diagram:list', repoId),
    read: (repoId: string, filename: string) =>
      ipcRenderer.invoke('diagram:read', repoId, filename),
    write: (repoId: string, filename: string, xml: string) =>
      ipcRenderer.invoke('diagram:write', repoId, filename, xml),
    delete: (repoId: string, filename: string) =>
      ipcRenderer.invoke('diagram:delete', repoId, filename),
    generate: (repoId: string, context: string, existingXml?: string) =>
      ipcRenderer.invoke('diagram:generate', repoId, context, existingXml),
    cancelGenerate: () => ipcRenderer.invoke('diagram:cancel-generate'),
    initialize: (repoId: string) => ipcRenderer.invoke('diagram:initialize', repoId),
    dirExists: (repoId: string) => ipcRenderer.invoke('diagram:dir-exists', repoId),
    openEditor: (repoId: string, filename: string) =>
      ipcRenderer.invoke('diagram:open-editor', repoId, filename),
    checkDrawio: () => ipcRenderer.invoke('diagram:check-drawio'),
  },

  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    get: (id: string) => ipcRenderer.invoke('workspace:get', id),
    getPreferences: (id: string) => ipcRenderer.invoke('workspace:get-preferences', id),
    create: (opts: WorkspaceCreateOptions) => ipcRenderer.invoke('workspace:create', opts),
    update: (id: string, opts: { name: string }) =>
      ipcRenderer.invoke('workspace:update', id, opts),
    delete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
    addRepos: (workspaceId: string, repoIds: string[]) =>
      ipcRenderer.invoke('workspace:add-repos', workspaceId, repoIds),
    removeRepos: (workspaceId: string, repoIds: string[]) =>
      ipcRenderer.invoke('workspace:remove-repos', workspaceId, repoIds),
    updatePreferences: (
      workspaceId: string,
      updates: {
        workitems?: Record<string, unknown>;
        docs?: Record<string, unknown>;
        launch?: Record<string, unknown>;
      },
    ) => ipcRenderer.invoke('workspace:update-preferences', workspaceId, updates),
    clearPreferences: (workspaceId: string, sections?: Array<'workitems' | 'docs' | 'launch'>) =>
      ipcRenderer.invoke('workspace:clear-preferences', workspaceId, sections),
    exportVSCodeWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke('workspace:export-vscode', workspaceId),
    openInNewWindow: (workspaceId: string) =>
      ipcRenderer.invoke('workspace:open-in-new-window', workspaceId),
  },

  workspaceScaffold: {
    start: (workspaceId: string, rootPath: string) =>
      ipcRenderer.invoke('workspace-scaffold:start', workspaceId, rootPath),
    getByWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke('workspace-scaffold:get-by-workspace', workspaceId),
    maybeComplete: (workspaceId: string, assistantMessage: string) =>
      ipcRenderer.invoke('workspace-scaffold:maybe-complete', workspaceId, assistantMessage),
    cancel: (workspaceId: string) => ipcRenderer.invoke('workspace-scaffold:cancel', workspaceId),
  },

  launch: {
    getPendingIntent: () => ipcRenderer.invoke('launch:get-pending-intent'),
    clearPendingIntent: () => ipcRenderer.invoke('launch:clear-pending-intent'),
    onIntent: (
      callback: (intent: import('../shared/types.js').OpenInAnvilLaunchIntent) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        intent: import('../shared/types.js').OpenInAnvilLaunchIntent,
      ) => callback(intent);
      ipcRenderer.on('launch:intent', handler);
      return () => ipcRenderer.removeListener('launch:intent', handler);
    },
  },

  design: {
    checkReadiness: () => ipcRenderer.invoke('design:check-readiness'),
    registerFigmaMcp: () =>
      ipcRenderer.invoke('design:register-figma-mcp') as Promise<{
        success: boolean;
        error?: string;
      }>,
    installFrontendSkill: () =>
      ipcRenderer.invoke('design:install-frontend-skill') as Promise<{
        success: boolean;
        error?: string;
      }>,
  },

  governance: {
    listBoards: (workspaceId: string) => ipcRenderer.invoke('governance:list-boards', workspaceId),
    createBoard: (workspaceId: string, name: string, description?: string) =>
      ipcRenderer.invoke('governance:create-board', workspaceId, name, description),
    updateBoard: (id: string, opts: { name?: string; description?: string }) =>
      ipcRenderer.invoke('governance:update-board', id, opts),
    deleteBoard: (id: string) => ipcRenderer.invoke('governance:delete-board', id),
    listDocuments: (workspaceId: string, boardId?: string) =>
      ipcRenderer.invoke('governance:list-documents', workspaceId, boardId),
    addDocument: (workspaceId: string, filePath: string, boardId?: string, description?: string) =>
      ipcRenderer.invoke('governance:add-document', workspaceId, filePath, boardId, description),
    updateDocument: (id: string, opts: { boardId?: string | null; description?: string }) =>
      ipcRenderer.invoke('governance:update-document', id, opts),
    removeDocument: (id: string) => ipcRenderer.invoke('governance:remove-document', id),
    selectFiles: () => ipcRenderer.invoke('governance:select-files'),
  },

  lifecycle: {
    createItem: (workspaceId: string, opts: Record<string, unknown>) =>
      ipcRenderer.invoke('lifecycle:create-item', workspaceId, opts),
    updateItem: (id: string, opts: Record<string, unknown>) =>
      ipcRenderer.invoke('lifecycle:update-item', id, opts),
    deleteItem: (id: string) => ipcRenderer.invoke('lifecycle:delete-item', id),
    getItem: (id: string) => ipcRenderer.invoke('lifecycle:get-item', id),
    listItems: (workspaceId: string, filters?: Record<string, unknown>) =>
      ipcRenderer.invoke('lifecycle:list-items', workspaceId, filters),
    linkRepos: (lifecycleItemId: string, repoIds: string[]) =>
      ipcRenderer.invoke('lifecycle:link-repos', lifecycleItemId, repoIds),
    unlinkRepo: (lifecycleItemId: string, repoId: string) =>
      ipcRenderer.invoke('lifecycle:unlink-repo', lifecycleItemId, repoId),
    listStages: (workspaceId: string) => ipcRenderer.invoke('lifecycle:list-stages', workspaceId),
    updateStages: (workspaceId: string, stages: Record<string, unknown>[]) =>
      ipcRenderer.invoke('lifecycle:update-stages', workspaceId, stages),
    resetStages: (workspaceId: string) => ipcRenderer.invoke('lifecycle:reset-stages', workspaceId),

    getGateTemplates: (workspaceId: string) =>
      ipcRenderer.invoke('lifecycle:get-gate-templates', workspaceId),
    updateGateTemplate: (workspaceId: string, gate: GateId, updates: GateTemplateUpdate) =>
      ipcRenderer.invoke('lifecycle:update-gate-template', workspaceId, gate, updates),
    resetGateTemplates: (workspaceId: string) =>
      ipcRenderer.invoke('lifecycle:reset-gate-templates', workspaceId),

    checkReadiness: (lifecycleItemId: string, gate: string) =>
      ipcRenderer.invoke('lifecycle:check-readiness', lifecycleItemId, gate),

    recordGateDecision: (lifecycleItemId: string, opts: Record<string, unknown>) =>
      ipcRenderer.invoke('lifecycle:record-gate-decision', lifecycleItemId, opts),
    listGateDecisions: (lifecycleItemId: string) =>
      ipcRenderer.invoke('lifecycle:list-gate-decisions', lifecycleItemId),

    runImpactAnalysis: (lifecycleItemId: string, opts: Record<string, unknown>) =>
      ipcRenderer.invoke('lifecycle:run-impact-analysis', lifecycleItemId, opts),
    getImpactAnalysis: (id: string) => ipcRenderer.invoke('lifecycle:get-impact-analysis', id),
    listImpactAnalyses: (lifecycleItemId: string) =>
      ipcRenderer.invoke('lifecycle:list-impact-analyses', lifecycleItemId),

    generateHandoverPack: (lifecycleItemId: string) =>
      ipcRenderer.invoke('lifecycle:generate-handover-pack', lifecycleItemId),
    listHandoverPacks: (lifecycleItemId: string) =>
      ipcRenderer.invoke('lifecycle:list-handover-packs', lifecycleItemId),
    exportHandoverPack: (packId: string) =>
      ipcRenderer.invoke('lifecycle:export-handover-pack', packId),

    onAnalysisProgress: (
      callback: (data: { lifecycleItemId: string; message: string; percent: number }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { lifecycleItemId: string; message: string; percent: number },
      ) => callback(data);
      ipcRenderer.on('lifecycle:analysis-progress', handler);
      return () => ipcRenderer.removeListener('lifecycle:analysis-progress', handler);
    },
    onHandoverProgress: (
      callback: (data: {
        lifecycleItemId: string;
        section: string;
        message: string;
        percent: number;
      }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { lifecycleItemId: string; section: string; message: string; percent: number },
      ) => callback(data);
      ipcRenderer.on('lifecycle:handover-progress', handler);
      return () => ipcRenderer.removeListener('lifecycle:handover-progress', handler);
    },
  },

  terminal: {
    create: (workspaceId: string, repoId: string, cwd: string) =>
      ipcRenderer.invoke('terminal:create', { workspaceId, repoId, cwd }),
    list: (workspaceId: string) => ipcRenderer.invoke('terminal:list', { workspaceId }),
    attach: (terminalId: string, afterSequence?: number) =>
      ipcRenderer.invoke('terminal:attach', { terminalId, afterSequence }),
    detach: (terminalId: string) => ipcRenderer.send('terminal:detach', { terminalId }),
    input: (terminalId: string, data: string) =>
      ipcRenderer.send('terminal:input', { terminalId, data }),
    resize: (terminalId: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', { terminalId, cols, rows }),
    close: (terminalId: string) => ipcRenderer.invoke('terminal:close', { terminalId }),
    onData: (callback: (data: TerminalDataEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: TerminalDataEvent) => callback(data);
      ipcRenderer.on('terminal:data', handler);
      return () => ipcRenderer.removeListener('terminal:data', handler);
    },
    onExit: (callback: (data: TerminalExitEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: TerminalExitEvent) => callback(data);
      ipcRenderer.on('terminal:exit', handler);
      return () => ipcRenderer.removeListener('terminal:exit', handler);
    },
    onClosed: (callback: (data: TerminalClosedEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: TerminalClosedEvent) => callback(data);
      ipcRenderer.on('terminal:closed', handler);
      return () => ipcRenderer.removeListener('terminal:closed', handler);
    },
  },

  browser: {
    listTargets: () => ipcRenderer.invoke('browser:list-targets'),
    addTarget: (url: string) => ipcRenderer.invoke('browser:add-target', url),
    getBridgeStatus: () => ipcRenderer.invoke('browser:get-bridge-status'),
    startBridge: () => ipcRenderer.invoke('browser:start-bridge'),
    stopBridge: () => ipcRenderer.invoke('browser:stop-bridge'),
    attachDebugger: () => ipcRenderer.invoke('browser:attach-debugger'),
    setUrl: (url: string) => ipcRenderer.invoke('browser:set-url', url),
    registerMcp: () =>
      ipcRenderer.invoke('browser:register-mcp') as Promise<{ success: boolean; error?: string }>,
    onTargetDetected: (callback: (target: DevServerTarget) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, target: DevServerTarget) => callback(target);
      ipcRenderer.on('browser:target-detected', handler);
      return () => ipcRenderer.removeListener('browser:target-detected', handler);
    },
  },

  simulatorPreview: {
    getStatus: () => ipcRenderer.invoke('simulator-preview:get-status'),
    start: (options?: SimulatorPreviewStartOptions) =>
      ipcRenderer.invoke('simulator-preview:start', options),
    stop: () => ipcRenderer.invoke('simulator-preview:stop'),
  },

  argent: {
    getSnapshot: () => ipcRenderer.invoke('argent:get-snapshot'),
    runCommand: (commandId: ArgentCommandId) => ipcRenderer.invoke('argent:run-command', commandId),
    startSimulatorPreview: () => ipcRenderer.invoke('argent:start-simulator-preview'),
  },

  editor: {
    getStatus: () => ipcRenderer.invoke('editor:get-status'),
    start: (workspaceId: string) => ipcRenderer.invoke('editor:start', workspaceId),
    stop: () => ipcRenderer.invoke('editor:stop'),
    focusTarget: (target: EmbeddedEditorTarget, options?: { startServer?: boolean }) =>
      ipcRenderer.invoke('editor:focus-target', target, options),
    openExternal: (target: EmbeddedEditorTarget) =>
      ipcRenderer.invoke('editor:open-external', target),
  },

  git: {
    status: (repoId: string) => ipcRenderer.invoke('git:status', repoId),
    workspaceStatus: (repoIds: string[]) => ipcRenderer.invoke('git:workspace-status', repoIds),
    stage: (repoId: string, paths: string[]) => ipcRenderer.invoke('git:stage', repoId, paths),
    unstage: (repoId: string, paths: string[]) => ipcRenderer.invoke('git:unstage', repoId, paths),
    discard: (repoId: string, paths: string[]) => ipcRenderer.invoke('git:discard', repoId, paths),
    commit: (repoId: string, message: string) => ipcRenderer.invoke('git:commit', repoId, message),
    generateCommitMessage: (repoId: string) =>
      ipcRenderer.invoke('git:generate-commit-message', repoId),
    createPullRequest: (repoId: string) => ipcRenderer.invoke('git:create-pull-request', repoId),
    push: (repoId: string, remote?: string, branch?: string, setUpstream?: boolean) =>
      ipcRenderer.invoke('git:push', repoId, remote, branch, setUpstream),
    pull: (repoId: string, remote?: string, branch?: string) =>
      ipcRenderer.invoke('git:pull', repoId, remote, branch),
    fetch: (repoId: string, remote?: string) => ipcRenderer.invoke('git:fetch', repoId, remote),
    log: (repoId: string, count?: number) => ipcRenderer.invoke('git:log', repoId, count),
    branches: (repoId: string) => ipcRenderer.invoke('git:branches', repoId),
    createBranch: (repoId: string, name: string, startPoint?: string) =>
      ipcRenderer.invoke('git:create-branch', repoId, name, startPoint),
    switchBranch: (repoId: string, name: string) =>
      ipcRenderer.invoke('git:switch-branch', repoId, name),
    deleteBranch: (repoId: string, name: string, force?: boolean) =>
      ipcRenderer.invoke('git:delete-branch', repoId, name, force),
    diff: (repoId: string, filePath: string, staged: boolean) =>
      ipcRenderer.invoke('git:diff', repoId, filePath, staged),
    merge: (repoId: string, branch: string) => ipcRenderer.invoke('git:merge', repoId, branch),
  },

  cicd: {
    analyze: (repoId: string) => ipcRenderer.invoke('cicd:analyze', repoId),
    createPipeline: (repoId: string, input) =>
      ipcRenderer.invoke('cicd:create-pipeline', repoId, input),
  },

  voice: {
    requestPermission: () => ipcRenderer.invoke('voice:request-permission'),
    startListening: () => ipcRenderer.invoke('voice:start-listening'),
    stopListening: () => ipcRenderer.invoke('voice:stop-listening'),
    getStatus: () => ipcRenderer.invoke('voice:get-status'),
    onResult: (callback: (text: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, text: string) => callback(text);
      ipcRenderer.on('voice:result', handler);
      return () => ipcRenderer.removeListener('voice:result', handler);
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on('voice:error', handler);
      return () => ipcRenderer.removeListener('voice:error', handler);
    },
    onStatus: (callback: (status: 'listening' | 'stopped' | 'error') => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: 'listening' | 'stopped' | 'error') =>
        callback(status);
      ipcRenderer.on('voice:status', handler);
      return () => ipcRenderer.removeListener('voice:status', handler);
    },
  },

  dependencies: {
    list: (repoId: string) => ipcRenderer.invoke('dependencies:list', repoId),
    audit: (repoId: string, manager: 'npm' | 'pnpm' | 'yarn' | 'nuget' | 'python') =>
      ipcRenderer.invoke('dependencies:audit', repoId, manager),
    auditLicenses: (repoId: string) => ipcRenderer.invoke('dependencies:audit-licenses', repoId),
    exportSbom: (repoId: string, format: 'cyclonedx-json' | 'spdx-json' | 'csv') =>
      ipcRenderer.invoke('dependencies:export-sbom', repoId, format),
  },

  compliance: {
    generate: (repoId: string, docType: ComplianceDocType) =>
      ipcRenderer.invoke('compliance:generate', repoId, docType),
    list: (repoId: string) => ipcRenderer.invoke('compliance:list', repoId),
    read: (repoId: string, docType: ComplianceDocType) =>
      ipcRenderer.invoke('compliance:read', repoId, docType),
    onProgress: (
      callback: (data: {
        repoId: string;
        docType: ComplianceDocType;
        message: string;
        percent: number;
      }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { repoId: string; docType: ComplianceDocType; message: string; percent: number },
      ) => callback(data);
      ipcRenderer.on('compliance:progress', handler);
      return () => ipcRenderer.removeListener('compliance:progress', handler);
    },
  },
};

contextBridge.exposeInMainWorld('anvil', api);
contextBridge.exposeInMainWorld('devhub', api);

contextBridge.exposeInMainWorld('brand', {
  get: () => ipcRenderer.invoke('brand:get'),
});
