import type {
  AppSettings,
  ChatLayout,
  WorkItemProvider,
  DocsProvider,
  AppTheme,
  CodexMode,
} from '../../shared/types.js';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  normaliseCodexModel,
  normaliseReasoningEffort,
} from '../../shared/codex-models.js';
import { getDb } from '../db/database.js';
import { decryptSecret, encryptSecret } from './auth.service.js';
import { testLlmConnection } from './llm.service.js';

interface SettingsRow {
  llm_provider: string | null;
  apple_foundation_models_mode: string | null;
  foundry_endpoint: string | null;
  foundry_deployment: string | null;
  foundry_api_version: string | null;
  foundry_api_key: Buffer | null;
  openai_api_key: Buffer | null;
  openai_model: string | null;
  reasoning_level: string | null;
  codex_mode: string | null;
  chat_layout: string | null;
  ado_org_url: string | null;
  ado_project: string | null;
  ado_team: string | null;
  ado_pat: Buffer | null;
  confluence_base_url: string | null;
  confluence_space_key: string | null;
  confluence_pat: Buffer | null;
  docs_provider: string | null;
  notion_oauth_token: Buffer | null;
  notion_oauth_expiry: string | null;
  notion_database_id: string | null;
  default_repo_path: string | null;
  work_item_provider: string | null;
  linear_api_key: Buffer | null;
  linear_team_id: string | null;
  jira_host: string | null;
  jira_auth_mode: string | null;
  jira_project: string | null;
  jira_board_id: string | null;
  jira_email: string | null;
  jira_api_token: Buffer | null;
  code_review_quick_glance_rubric: string | null;
  code_review_senior_dev_rubric: string | null;
  theme: string | null;
  user_role: string | null;
  active_workspace_id: string | null;
  github_pat: Buffer | null;
  github_username: string | null;
  cloud_features_enabled: number | null;
}

const APP_THEMES: AppTheme[] = [
  'system',
  'dark',
  'prompt-whisperer',
  'merge-conflict',
  'token-bender',
  'agent-after-hours',
];
const CODEX_MODES: CodexMode[] = ['read-only', 'on-request', 'workspace-auto', 'full-access'];
const CHAT_LAYOUTS: ChatLayout[] = ['classic', 'workitems'];
const APPLE_FOUNDATION_MODEL_MODES: AppSettings['appleFoundationModelsMode'][] = [
  'off',
  'prefer-simple',
];

function normaliseTheme(theme: string | null | undefined): AppTheme {
  return APP_THEMES.includes(theme as AppTheme) ? (theme as AppTheme) : 'system';
}

function normaliseCodexMode(mode: string | null | undefined): CodexMode {
  return CODEX_MODES.includes(mode as CodexMode) ? (mode as CodexMode) : 'on-request';
}

function normaliseChatLayout(layout: string | null | undefined): ChatLayout {
  return CHAT_LAYOUTS.includes(layout as ChatLayout) ? (layout as ChatLayout) : 'classic';
}

function normaliseAppleFoundationModelsMode(
  mode: string | null | undefined,
): AppSettings['appleFoundationModelsMode'] {
  return APPLE_FOUNDATION_MODEL_MODES.includes(mode as AppSettings['appleFoundationModelsMode'])
    ? (mode as AppSettings['appleFoundationModelsMode'])
    : 'off';
}

export function getSettings(): AppSettings {
  const db = getDb();
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow | undefined;

  if (!row) {
    return defaultSettings();
  }

  return {
    llmProvider: (row.llm_provider as 'azure' | 'openai' | 'codex') ?? 'codex',
    appleFoundationModelsMode: normaliseAppleFoundationModelsMode(row.apple_foundation_models_mode),
    foundryEndpoint: row.foundry_endpoint ?? '',
    foundryDeploymentName: row.foundry_deployment ?? '',
    foundryApiVersion: row.foundry_api_version ?? '2024-10-21',
    foundryApiKey: decryptSecret(row.foundry_api_key, 'settings.foundryApiKey'),
    openaiApiKey: decryptSecret(row.openai_api_key, 'settings.openaiApiKey'),
    openaiModel: normaliseCodexModel(row.openai_model),
    reasoningLevel: normaliseReasoningEffort(row.reasoning_level),
    codexMode: normaliseCodexMode(row.codex_mode),
    chatLayout: normaliseChatLayout(row.chat_layout),
    adoOrganizationUrl: row.ado_org_url ?? '',
    adoProject: row.ado_project ?? '',
    adoTeam: row.ado_team ?? undefined,
    adoPat: decryptSecret(row.ado_pat, 'settings.adoPat'),
    workItemProvider: (row.work_item_provider as WorkItemProvider | 'none') ?? 'ado',
    linearApiKey: decryptSecret(row.linear_api_key, 'settings.linearApiKey'),
    linearTeamId: row.linear_team_id ?? undefined,
    jiraHost: row.jira_host ?? undefined,
    jiraAuthMode: (row.jira_auth_mode as 'cloud' | 'server') ?? undefined,
    jiraProject: row.jira_project ?? undefined,
    jiraBoardId: row.jira_board_id ?? undefined,
    jiraEmail: row.jira_email ?? undefined,
    jiraApiToken: decryptSecret(row.jira_api_token, 'settings.jiraApiToken'),
    confluenceBaseUrl: row.confluence_base_url ?? '',
    confluenceSpaceKey: row.confluence_space_key ?? '',
    confluencePat: decryptSecret(row.confluence_pat, 'settings.confluencePat'),
    docsProvider: (row.docs_provider as DocsProvider | 'none') ?? 'confluence',
    notionOauthToken: decryptSecret(row.notion_oauth_token, 'settings.notionOauthToken'),
    notionOauthExpiry: row.notion_oauth_expiry ?? undefined,
    notionDatabaseId: row.notion_database_id ?? undefined,
    codeReviewQuickGlanceRubric: row.code_review_quick_glance_rubric ?? undefined,
    codeReviewSeniorDevRubric: row.code_review_senior_dev_rubric ?? undefined,
    userRole: (row.user_role as AppSettings['userRole']) ?? undefined,
    activeWorkspaceId: row.active_workspace_id ?? undefined,
    githubPat: decryptSecret(row.github_pat, 'settings.githubPat'),
    githubUsername: row.github_username ?? undefined,
    cloudFeaturesEnabled: row.cloud_features_enabled === 1,
    defaultRepoPath: row.default_repo_path ?? undefined,
    theme: normaliseTheme(row.theme),
  };
}

export function updateSettings(partial: Partial<AppSettings>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (partial.llmProvider !== undefined) {
    setClauses.push('llm_provider = ?');
    values.push(partial.llmProvider);
  }
  if (partial.appleFoundationModelsMode !== undefined) {
    setClauses.push('apple_foundation_models_mode = ?');
    values.push(normaliseAppleFoundationModelsMode(partial.appleFoundationModelsMode));
  }
  if (partial.foundryEndpoint !== undefined) {
    setClauses.push('foundry_endpoint = ?');
    values.push(partial.foundryEndpoint);
  }
  if (partial.foundryDeploymentName !== undefined) {
    setClauses.push('foundry_deployment = ?');
    values.push(partial.foundryDeploymentName);
  }
  if (partial.foundryApiVersion !== undefined) {
    setClauses.push('foundry_api_version = ?');
    values.push(partial.foundryApiVersion);
  }
  if (partial.foundryApiKey !== undefined) {
    setClauses.push('foundry_api_key = ?');
    values.push(partial.foundryApiKey ? encryptSecret(partial.foundryApiKey) : null);
  }
  if (partial.openaiApiKey !== undefined) {
    setClauses.push('openai_api_key = ?');
    values.push(partial.openaiApiKey ? encryptSecret(partial.openaiApiKey) : null);
  }
  if (partial.openaiModel !== undefined) {
    setClauses.push('openai_model = ?');
    values.push(partial.openaiModel);
  }
  if (partial.reasoningLevel !== undefined) {
    setClauses.push('reasoning_level = ?');
    values.push(partial.reasoningLevel);
  }
  if (partial.codexMode !== undefined) {
    setClauses.push('codex_mode = ?');
    values.push(normaliseCodexMode(partial.codexMode));
  }
  if (partial.chatLayout !== undefined) {
    setClauses.push('chat_layout = ?');
    values.push(normaliseChatLayout(partial.chatLayout));
  }
  if (partial.adoOrganizationUrl !== undefined) {
    setClauses.push('ado_org_url = ?');
    values.push(partial.adoOrganizationUrl);
  }
  if (partial.adoProject !== undefined) {
    setClauses.push('ado_project = ?');
    values.push(partial.adoProject);
  }
  if (partial.adoTeam !== undefined) {
    setClauses.push('ado_team = ?');
    values.push(partial.adoTeam);
  }
  if (partial.adoPat !== undefined) {
    setClauses.push('ado_pat = ?');
    values.push(partial.adoPat ? encryptSecret(partial.adoPat) : null);
  }
  if (partial.confluenceBaseUrl !== undefined) {
    setClauses.push('confluence_base_url = ?');
    values.push(partial.confluenceBaseUrl);
  }
  if (partial.confluenceSpaceKey !== undefined) {
    setClauses.push('confluence_space_key = ?');
    values.push(partial.confluenceSpaceKey);
  }
  if (partial.confluencePat !== undefined) {
    setClauses.push('confluence_pat = ?');
    values.push(partial.confluencePat ? encryptSecret(partial.confluencePat) : null);
  }
  if (partial.docsProvider !== undefined) {
    setClauses.push('docs_provider = ?');
    values.push(partial.docsProvider);
  }
  if (partial.notionOauthToken !== undefined) {
    setClauses.push('notion_oauth_token = ?');
    values.push(partial.notionOauthToken ? encryptSecret(partial.notionOauthToken) : null);
  }
  if (partial.notionOauthExpiry !== undefined) {
    setClauses.push('notion_oauth_expiry = ?');
    values.push(partial.notionOauthExpiry || null);
  }
  if (partial.notionDatabaseId !== undefined) {
    setClauses.push('notion_database_id = ?');
    values.push(partial.notionDatabaseId || null);
  }
  if (partial.defaultRepoPath !== undefined) {
    setClauses.push('default_repo_path = ?');
    values.push(partial.defaultRepoPath);
  }
  if (partial.workItemProvider !== undefined) {
    // If provider changed, clear cached work items
    const current = getSettings();
    if (current.workItemProvider !== partial.workItemProvider) {
      db.prepare('DELETE FROM work_items_cache').run();
    }
    setClauses.push('work_item_provider = ?');
    values.push(partial.workItemProvider);
  }
  if (partial.linearApiKey !== undefined) {
    setClauses.push('linear_api_key = ?');
    values.push(partial.linearApiKey ? encryptSecret(partial.linearApiKey) : null);
  }
  if (partial.linearTeamId !== undefined) {
    setClauses.push('linear_team_id = ?');
    values.push(partial.linearTeamId);
  }
  if (partial.jiraHost !== undefined) {
    setClauses.push('jira_host = ?');
    values.push(partial.jiraHost);
  }
  if (partial.jiraAuthMode !== undefined) {
    setClauses.push('jira_auth_mode = ?');
    values.push(partial.jiraAuthMode);
  }
  if (partial.jiraProject !== undefined) {
    setClauses.push('jira_project = ?');
    values.push(partial.jiraProject);
  }
  if (partial.jiraBoardId !== undefined) {
    setClauses.push('jira_board_id = ?');
    values.push(partial.jiraBoardId);
  }
  if (partial.jiraEmail !== undefined) {
    setClauses.push('jira_email = ?');
    values.push(partial.jiraEmail);
  }
  if (partial.jiraApiToken !== undefined) {
    setClauses.push('jira_api_token = ?');
    values.push(partial.jiraApiToken ? encryptSecret(partial.jiraApiToken) : null);
  }
  if (partial.codeReviewQuickGlanceRubric !== undefined) {
    setClauses.push('code_review_quick_glance_rubric = ?');
    values.push(partial.codeReviewQuickGlanceRubric || null);
  }
  if (partial.codeReviewSeniorDevRubric !== undefined) {
    setClauses.push('code_review_senior_dev_rubric = ?');
    values.push(partial.codeReviewSeniorDevRubric || null);
  }
  if (partial.userRole !== undefined) {
    setClauses.push('user_role = ?');
    values.push(partial.userRole || null);
  }
  if (partial.activeWorkspaceId !== undefined) {
    setClauses.push('active_workspace_id = ?');
    values.push(partial.activeWorkspaceId || null);
  }
  if (partial.githubPat !== undefined) {
    setClauses.push('github_pat = ?');
    values.push(partial.githubPat ? encryptSecret(partial.githubPat) : null);
  }
  if (partial.githubUsername !== undefined) {
    setClauses.push('github_username = ?');
    values.push(partial.githubUsername || null);
  }
  if (partial.cloudFeaturesEnabled !== undefined) {
    setClauses.push('cloud_features_enabled = ?');
    values.push(partial.cloudFeaturesEnabled ? 1 : 0);
  }
  if (partial.theme !== undefined) {
    setClauses.push('theme = ?');
    values.push(normaliseTheme(partial.theme));
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = datetime('now')");
  const sql = `UPDATE settings SET ${setClauses.join(', ')} WHERE id = 1`;
  db.prepare(sql).run(...values);
}

export async function testFoundryConnection(): Promise<{ ok: boolean; error?: string }> {
  return testLlmConnection();
}

export async function testConfluenceConnection(): Promise<{ ok: boolean; error?: string }> {
  const { confluenceProvider } = await import('./confluence.service.js');
  return confluenceProvider.testConnection();
}

export async function testDocsProviderConnection(): Promise<{ ok: boolean; error?: string }> {
  const { getActiveDocsProvider } = await import('./docs-provider.js');
  const provider = getActiveDocsProvider();
  if (!provider) return { ok: false, error: 'No docs provider selected' };
  return provider.testConnection();
}

export async function testGitConnection(): Promise<{
  ok: boolean;
  error?: string;
  username?: string;
}> {
  try {
    const settings = getSettings();

    // GitHub: use gh CLI auth
    const { checkGhAuthStatus } = await import('./remote-repo.service.js');
    const ghAuth = await checkGhAuthStatus();
    if (ghAuth.authenticated) {
      return { ok: true, username: ghAuth.username };
    }

    // ADO: use PAT
    if (settings.adoPat && settings.adoOrganizationUrl) {
      const base = settings.adoOrganizationUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/_apis/connectionData`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 203)
          return { ok: false, error: 'Invalid ADO PAT' };
        return { ok: false, error: `ADO API returned HTTP ${res.status}` };
      }
      return { ok: true };
    }

    return { ok: false, error: ghAuth.error ?? 'No git provider configured' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      return { ok: false, error: 'Connection failed — check your network' };
    }
    return { ok: false, error: msg };
  }
}

function defaultSettings(): AppSettings {
  return {
    llmProvider: 'codex',
    appleFoundationModelsMode: 'off',
    foundryEndpoint: '',
    foundryDeploymentName: '',
    foundryApiVersion: '2024-10-21',
    openaiModel: DEFAULT_CODEX_MODEL,
    reasoningLevel: DEFAULT_CODEX_REASONING_EFFORT,
    codexMode: 'on-request',
    chatLayout: 'classic',
    workItemProvider: 'ado',
    docsProvider: 'confluence',
    adoOrganizationUrl: '',
    adoProject: '',
    confluenceBaseUrl: '',
    confluenceSpaceKey: '',
    activeWorkspaceId: undefined,
    githubPat: undefined,
    githubUsername: undefined,
    cloudFeaturesEnabled: false,
    theme: 'system',
  };
}

export function resetOnboardingState(): void {
  const db = getDb();
  db.prepare('UPDATE settings SET user_role = NULL, active_workspace_id = NULL WHERE id = 1').run();
  db.prepare('DELETE FROM workspace_preferences').run();
  db.prepare('DELETE FROM workspace_repos').run();
  db.prepare('DELETE FROM workspaces').run();
  db.prepare('DELETE FROM workspace_scaffold_sessions').run();
}
