import { useEffect, useState } from 'react';
import { CheckCircle, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import type { AppSettings, DocsProvider, WorkItemConnection } from '../../../../shared/types';
import { Button } from '../../ui';
import { useSettingsContext } from '../SettingsContext';
import {
  ButtonGrid,
  CredentialSaveControls,
  Field,
  ProviderButton,
  SettingsPanel,
  TestButton,
  type TestStatus,
} from '../settings-ui';
import {
  DOCS_CREDENTIAL_KEYS,
  GIT_CREDENTIAL_KEYS,
  WORK_ITEM_CREDENTIAL_KEYS,
} from '../settings-keys';

/** Credential keys owned by each panel — Test saves only its own set (ST2). */
const WORK_ITEM_KEYS = WORK_ITEM_CREDENTIAL_KEYS;
const DOCS_KEYS = DOCS_CREDENTIAL_KEYS;
const GIT_KEYS = GIT_CREDENTIAL_KEYS;

export function DeliveryCategory() {
  const { draft, reportError } = useSettingsContext();
  const { settings } = draft;

  const [wiStatus, setWiStatus] = useState<TestStatus>('idle');
  const [confluenceStatus, setConfluenceStatus] = useState<TestStatus>('idle');
  const [docsStatus, setDocsStatus] = useState<TestStatus>('idle');
  const [gitStatus, setGitStatus] = useState<TestStatus>('idle');
  const [gitProvider, setGitProvider] = useState<'github' | 'ado'>('github');
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [linearTeams, setLinearTeams] = useState<Array<{ id: string; name: string; key: string }>>(
    [],
  );
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [notionMcpInstalled, setNotionMcpInstalled] = useState(false);
  const [notionInstalling, setNotionInstalling] = useState(false);
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [savingForTest, setSavingForTest] = useState<TestStatus | 'none'>('none');
  const [gitProviderHydrated, setGitProviderHydrated] = useState(false);

  useEffect(() => {
    window.anvil.repo.ghAuthStatus().then((status) => {
      if (status.authenticated) {
        setGhUsername(status.username ?? null);
        setGitStatus('ok');
      } else {
        setGhError(status.error ?? null);
      }
    });
    window.anvil.settings.getNotionMcpStatus().then((s) => {
      setNotionMcpInstalled(s.installed);
    });
  }, []);

  // The Git provider toggle is display state derived from which credentials
  // exist — hydrate it once the draft loads.
  useEffect(() => {
    if (!gitProviderHydrated && draft.loaded) {
      setGitProvider(
        draft.persisted.adoPat || draft.persisted.adoOrganizationUrl ? 'ado' : 'github',
      );
      setGitProviderHydrated(true);
    }
  }, [
    draft.loaded,
    draft.persisted.adoPat,
    draft.persisted.adoOrganizationUrl,
    gitProviderHydrated,
  ]);

  const workItemConnections = settings.workItemConnections ?? [];
  const activeWorkItemConnection = workItemConnections.find(
    (connection) => connection.id === settings.activeWorkItemConnectionId,
  );
  const wiProvider = activeWorkItemConnection?.provider ?? 'none';
  const selectedDocsProvider: DocsProvider | 'none' = settings.docsProvider ?? 'confluence';

  const activateWorkItemConnection = (connection: WorkItemConnection) => {
    draft.updateMany(
      {
        activeWorkItemConnectionId: connection.id,
        workItemProvider: connection.provider,
        adoOrganizationUrl: connection.adoOrganizationUrl ?? '',
        adoProject: connection.adoProject ?? '',
        adoTeam: connection.adoTeam,
        adoPat: connection.adoPat,
        linearApiKey: connection.linearApiKey,
        linearTeamId: connection.linearTeamId,
        jiraHost: connection.jiraHost,
        jiraAuthMode: connection.jiraAuthMode,
        jiraProject: connection.jiraProject,
        jiraBoardId: connection.jiraBoardId,
        jiraAcceptanceCriteriaField: connection.jiraAcceptanceCriteriaField,
        jiraEmail: connection.jiraEmail,
        jiraApiToken: connection.jiraApiToken,
      },
      'manual',
    );
    setWiStatus('idle');
  };

  const addWorkItemConnection = () => {
    const connection: WorkItemConnection = {
      id: crypto.randomUUID(),
      name: `Work items ${workItemConnections.length + 1}`,
      provider: 'ado',
      jiraAuthMode: 'cloud',
    };
    draft.updateMany({ workItemConnections: [...workItemConnections, connection] }, 'manual');
    activateWorkItemConnection(connection);
  };

  const updateWorkItemConnection = <K extends keyof WorkItemConnection>(
    key: K,
    value: WorkItemConnection[K],
  ) => {
    const activeId = settings.activeWorkItemConnectionId;
    const connections = workItemConnections.map((connection) =>
      connection.id === activeId ? { ...connection, [key]: value } : connection,
    );
    const active = connections.find((connection) => connection.id === activeId);
    draft.updateMany(
      active
        ? {
            workItemConnections: connections,
            workItemProvider: active.provider,
            adoOrganizationUrl: active.adoOrganizationUrl ?? '',
            adoProject: active.adoProject ?? '',
            adoTeam: active.adoTeam,
            adoPat: active.adoPat,
            linearApiKey: active.linearApiKey,
            linearTeamId: active.linearTeamId,
            jiraHost: active.jiraHost,
            jiraAuthMode: active.jiraAuthMode,
            jiraProject: active.jiraProject,
            jiraBoardId: active.jiraBoardId,
            jiraAcceptanceCriteriaField: active.jiraAcceptanceCriteriaField,
            jiraEmail: active.jiraEmail,
            jiraApiToken: active.jiraApiToken,
          }
        : { workItemConnections: connections },
      'manual',
    );
    setWiStatus('idle');
  };

  const removeActiveWorkItemConnection = () => {
    const remaining = workItemConnections.filter(
      (connection) => connection.id !== settings.activeWorkItemConnectionId,
    );
    if (remaining[0]) {
      draft.update('workItemConnections', remaining, 'manual');
      activateWorkItemConnection(remaining[0]);
    } else {
      draft.updateMany(
        {
          workItemConnections: [],
          activeWorkItemConnectionId: undefined,
          workItemProvider: 'none',
        },
        'manual',
      );
    }
  };

  /** Save only the given panel's credential fields ahead of a test (ST2). */
  const savePanelForTest = async (keys: ReadonlyArray<keyof AppSettings>, tag: TestStatus) => {
    setSavingForTest(tag);
    try {
      await draft.flushAutosave();
      const dirty = keys.filter((key) => draft.dirtyKeys.has(key));
      if (dirty.length > 0) await draft.saveKeys(dirty);
    } finally {
      setSavingForTest('none');
    }
  };

  const testWi = async () => {
    setWiStatus('testing');
    reportError(null);
    try {
      await savePanelForTest(WORK_ITEM_KEYS, 'testing');
      const result = await window.anvil.settings.testWorkItemProviderConnection();
      setWiStatus(result.ok ? 'ok' : 'error');
      if (result.error) reportError(result.error);
    } catch (err) {
      setWiStatus('error');
      reportError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const testConfluence = async () => {
    setConfluenceStatus('testing');
    reportError(null);
    await savePanelForTest(DOCS_KEYS, 'testing');
    try {
      const result = await window.anvil.settings.testConfluenceConnection();
      setConfluenceStatus(result.ok ? 'ok' : 'error');
      if (result.error) reportError(result.error);
    } catch (err) {
      setConfluenceStatus('error');
      reportError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const testGit = async () => {
    setGitStatus('testing');
    reportError(null);
    setGhError(null);
    await savePanelForTest(GIT_KEYS, 'testing');
    try {
      if (gitProvider === 'github') {
        const status = await window.anvil.repo.ghAuthStatus();
        if (status.authenticated) {
          setGitStatus('ok');
          setGhUsername(status.username ?? null);
        } else {
          setGitStatus('error');
          setGhError(status.error ?? 'Not authenticated');
          reportError(status.error ?? 'Not authenticated');
        }
      } else {
        const result = await window.anvil.settings.testGitConnection();
        setGitStatus(result.ok ? 'ok' : 'error');
        if (result.error) reportError(result.error);
      }
    } catch (err) {
      setGitStatus('error');
      reportError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const testDocs = async () => {
    setDocsStatus('testing');
    reportError(null);
    await savePanelForTest(DOCS_KEYS, 'testing');
    try {
      const result = await window.anvil.settings.testDocsProviderConnection();
      setDocsStatus(result.ok ? 'ok' : 'error');
      if (result.error) reportError(result.error);
    } catch (err) {
      setDocsStatus('error');
      reportError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const installNotionMcp = async () => {
    setNotionInstalling(true);
    reportError(null);
    try {
      const result = await window.anvil.settings.installNotionMcp();
      if (result.success) {
        setNotionMcpInstalled(true);
      } else {
        reportError(result.error ?? 'Failed to install Notion MCP');
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to install Notion MCP');
    } finally {
      setNotionInstalling(false);
    }
  };

  const connectNotion = async () => {
    setNotionConnecting(true);
    reportError(null);
    try {
      const { authUrl } = await window.anvil.settings.startNotionOAuthFlow();
      if (authUrl) {
        window.open(authUrl, '_blank');
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to start Notion OAuth');
    } finally {
      setNotionConnecting(false);
    }
  };

  const fetchLinearTeams = async () => {
    setLoadingTeams(true);
    // Persist this panel's credentials first so the lookup uses them (ST2).
    await savePanelForTest(WORK_ITEM_KEYS, 'testing');
    try {
      const teams = await window.anvil.settings.listLinearTeams();
      setLinearTeams(teams);
    } catch {
      reportError('Failed to fetch teams — check your API key');
    } finally {
      setLoadingTeams(false);
    }
  };

  return (
    <>
      <SettingsPanel
        panelId="work-items"
        title="Work Items"
        description="Keep multiple named backlog and issue connections, with one active at a time."
        saveKeys={WORK_ITEM_KEYS}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-52 flex-1 space-y-1">
              <label className="block text-sm text-text-secondary">Active connection</label>
              <select
                value={settings.activeWorkItemConnectionId ?? ''}
                onChange={(event) => {
                  const connection = workItemConnections.find(
                    (candidate) => candidate.id === event.target.value,
                  );
                  if (connection) activateWorkItemConnection(connection);
                }}
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
              >
                {workItemConnections.length === 0 && (
                  <option value="">No connections configured</option>
                )}
                {workItemConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} · {connection.provider.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="secondary" size="sm" onClick={addWorkItemConnection}>
              <Plus size={14} /> Add
            </Button>
            {activeWorkItemConnection && (
              <Button variant="secondary" size="sm" onClick={removeActiveWorkItemConnection}>
                <Trash2 size={14} /> Remove
              </Button>
            )}
          </div>

          {activeWorkItemConnection && (
            <Field
              label="Connection name"
              value={activeWorkItemConnection.name}
              onChange={(value) => updateWorkItemConnection('name', value)}
              placeholder="e.g. Product Linear"
            />
          )}

          {activeWorkItemConnection && (
            <>
              <label className="block text-sm text-text-secondary">Provider</label>
              <ButtonGrid>
                <ProviderButton
                  label="Azure DevOps"
                  description="ADO boards and backlogs"
                  active={wiProvider === 'ado'}
                  onClick={() => updateWorkItemConnection('provider', 'ado')}
                />
                <ProviderButton
                  label="Linear"
                  description="Modern issue tracking"
                  active={wiProvider === 'linear'}
                  onClick={() => updateWorkItemConnection('provider', 'linear')}
                />
                <ProviderButton
                  label="JIRA"
                  description="Atlassian project tracking"
                  active={wiProvider === 'jira'}
                  onClick={() => updateWorkItemConnection('provider', 'jira')}
                />
              </ButtonGrid>
            </>
          )}
        </div>

        {wiProvider === 'ado' && (
          <>
            <Field
              label="Organisation URL"
              value={activeWorkItemConnection?.adoOrganizationUrl ?? ''}
              onChange={(v) => updateWorkItemConnection('adoOrganizationUrl', v)}
              placeholder="https://dev.azure.com/your-org"
            />
            <Field
              label="Project"
              value={activeWorkItemConnection?.adoProject ?? ''}
              onChange={(v) => updateWorkItemConnection('adoProject', v)}
            />
            <Field
              label="Team (optional)"
              value={activeWorkItemConnection?.adoTeam ?? ''}
              onChange={(v) => updateWorkItemConnection('adoTeam', v)}
            />
            <Field
              label="Personal Access Token"
              value={activeWorkItemConnection?.adoPat ?? ''}
              onChange={(v) => updateWorkItemConnection('adoPat', v)}
              type="password"
            />
          </>
        )}

        {wiProvider === 'linear' && (
          <>
            <Field
              label="API Key"
              value={activeWorkItemConnection?.linearApiKey ?? ''}
              onChange={(v) => updateWorkItemConnection('linearApiKey', v)}
              type="password"
              placeholder="lin_api_..."
            />
            <div className="space-y-1">
              <label className="block text-sm text-text-secondary">Team (optional)</label>
              <div className="flex gap-2">
                <select
                  value={activeWorkItemConnection?.linearTeamId ?? ''}
                  onChange={(e) => updateWorkItemConnection('linearTeamId', e.target.value)}
                  className="flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">All teams</option>
                  {linearTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.key})
                    </option>
                  ))}
                </select>
                <button
                  onClick={fetchLinearTeams}
                  disabled={loadingTeams || !activeWorkItemConnection?.linearApiKey}
                  className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
                >
                  {loadingTeams && <Loader2 size={12} className="animate-spin" />}
                  Fetch Teams
                </button>
              </div>
              <p className="text-sm text-text-tertiary">
                Save your API key first, then click Fetch Teams to discover available teams.
              </p>
            </div>
          </>
        )}

        {wiProvider === 'jira' && (
          <>
            <Field
              label="Host"
              value={activeWorkItemConnection?.jiraHost ?? ''}
              onChange={(v) => updateWorkItemConnection('jiraHost', v)}
              placeholder="mycompany.atlassian.net"
            />
            <div className="space-y-1">
              <label className="block text-sm text-text-secondary">Auth Mode</label>
              <div className="flex gap-2">
                <ProviderButton
                  label="Cloud"
                  description="Atlassian Cloud"
                  active={(activeWorkItemConnection?.jiraAuthMode ?? 'cloud') === 'cloud'}
                  onClick={() => updateWorkItemConnection('jiraAuthMode', 'cloud')}
                />
                <ProviderButton
                  label="Server"
                  description="Data Center / Server"
                  active={activeWorkItemConnection?.jiraAuthMode === 'server'}
                  onClick={() => updateWorkItemConnection('jiraAuthMode', 'server')}
                />
              </div>
            </div>
            <Field
              label="Project Key"
              value={activeWorkItemConnection?.jiraProject ?? ''}
              onChange={(v) => updateWorkItemConnection('jiraProject', v)}
              placeholder="ENG"
            />
            <Field
              label="Board ID (optional)"
              value={activeWorkItemConnection?.jiraBoardId ?? ''}
              onChange={(v) => updateWorkItemConnection('jiraBoardId', v)}
              placeholder="Auto-discovered if blank"
            />
            <Field
              label="Acceptance criteria field, optional"
              value={activeWorkItemConnection?.jiraAcceptanceCriteriaField ?? ''}
              onChange={(v) => updateWorkItemConnection('jiraAcceptanceCriteriaField', v)}
              placeholder="customfield_12345"
            />
            {(activeWorkItemConnection?.jiraAuthMode ?? 'cloud') === 'cloud' && (
              <Field
                label="Email"
                value={activeWorkItemConnection?.jiraEmail ?? ''}
                onChange={(v) => updateWorkItemConnection('jiraEmail', v)}
                placeholder="you@company.com"
              />
            )}
            <Field
              label="API Token"
              value={activeWorkItemConnection?.jiraApiToken ?? ''}
              onChange={(v) => updateWorkItemConnection('jiraApiToken', v)}
              type="password"
            />
          </>
        )}

        <CredentialSaveControls keys={WORK_ITEM_KEYS} />

        {wiProvider !== 'none' && (
          <TestButton
            status={wiStatus}
            onClick={testWi}
            savingCredentials={savingForTest === 'testing' && wiStatus === 'testing'}
          />
        )}
      </SettingsPanel>

      <SettingsPanel
        panelId="docs"
        title="Documentation"
        description="Configure documentation providers for generated and retrieved project knowledge."
        saveKeys={DOCS_KEYS}
      >
        <div className="space-y-3">
          <label className="block text-sm text-text-secondary">Provider</label>
          <ButtonGrid>
            <ProviderButton
              label="None"
              description="No documentation integration"
              active={selectedDocsProvider === 'none'}
              onClick={() => draft.update('docsProvider', 'none')}
            />
            <ProviderButton
              label="Confluence"
              description="Confluence Data Center"
              active={selectedDocsProvider === 'confluence'}
              onClick={() => draft.update('docsProvider', 'confluence')}
            />
            <ProviderButton
              label="Notion"
              description="Notion via MCP"
              active={selectedDocsProvider === 'notion'}
              onClick={() => draft.update('docsProvider', 'notion')}
            />
          </ButtonGrid>
        </div>

        {selectedDocsProvider === 'confluence' && (
          <>
            <Field
              label="Base URL"
              value={settings.confluenceBaseUrl ?? ''}
              onChange={(v) => draft.update('confluenceBaseUrl', v)}
              placeholder="https://confluence.internal.lancs.ac.uk"
              saveKey="confluenceBaseUrl"
            />
            <Field
              label="Space Key"
              value={settings.confluenceSpaceKey ?? ''}
              onChange={(v) => draft.update('confluenceSpaceKey', v)}
              saveKey="confluenceSpaceKey"
            />
            <Field
              label="Personal Access Token"
              value={settings.confluencePat ?? ''}
              onChange={(v) => draft.update('confluencePat', v)}
              type="password"
              saveKey="confluencePat"
            />
            <TestButton
              status={confluenceStatus}
              onClick={testConfluence}
              savingCredentials={savingForTest === 'testing' && confluenceStatus === 'testing'}
            />
          </>
        )}

        {selectedDocsProvider === 'notion' && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
              <h4 className="text-sm font-medium text-text-primary">Notion MCP Server</h4>
              <p className="text-xs text-text-tertiary">
                Notion integration requires the MCP server to be installed for Codex CLI.
              </p>
              {notionMcpInstalled ? (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle size={14} />
                  MCP server installed
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={installNotionMcp}
                  disabled={notionInstalling}
                >
                  {notionInstalling && <Loader2 size={12} className="animate-spin" />}
                  Install MCP Server
                </Button>
              )}
            </div>

            <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
              <h4 className="text-sm font-medium text-text-primary">Notion Authentication</h4>
              <p className="text-xs text-text-tertiary">
                Connect your Notion account via OAuth to access and create pages.
              </p>
              {settings.notionOauthToken ? (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle size={14} />
                  Connected to Notion
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={connectNotion}
                  disabled={notionConnecting}
                >
                  {notionConnecting && <Loader2 size={12} className="animate-spin" />}
                  Connect Notion
                </Button>
              )}
            </div>

            <Field
              label="Database ID (optional)"
              value={settings.notionDatabaseId ?? ''}
              onChange={(v) => draft.update('notionDatabaseId', v)}
              placeholder="Used as default parent for new pages"
            />
          </div>
        )}

        <CredentialSaveControls keys={DOCS_KEYS} />

        {selectedDocsProvider !== 'none' && selectedDocsProvider !== 'confluence' && (
          <TestButton
            status={docsStatus}
            onClick={testDocs}
            savingCredentials={savingForTest === 'testing' && docsStatus === 'testing'}
          />
        )}
      </SettingsPanel>

      <SettingsPanel
        panelId="git"
        title="Git provider"
        description="Credentials used to browse and clone remote repositories."
        saveKeys={GIT_KEYS}
      >
        <div className="space-y-3">
          <label className="block text-sm text-text-secondary">Provider</label>
          <ButtonGrid>
            <ProviderButton
              label="GitHub"
              description="GitHub.com or Enterprise"
              active={gitProvider === 'github'}
              onClick={() => setGitProvider('github')}
            />
            <ProviderButton
              label="Azure DevOps"
              description="ADO repositories"
              active={gitProvider === 'ado'}
              onClick={() => setGitProvider('ado')}
            />
          </ButtonGrid>
        </div>

        {gitProvider === 'github' && (
          <div className="rounded-md border border-border bg-bg-primary p-3">
            {ghUsername ? (
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-success" />
                <span className="text-sm text-text-primary">
                  Authenticated as <span className="font-medium text-accent">{ghUsername}</span>
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-text-secondary">
                  GitHub uses the{' '}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs font-mono text-accent">
                    gh
                  </code>{' '}
                  CLI for authentication.
                </p>
                {ghError && (
                  <div className="flex items-center gap-2 text-sm text-warning">
                    <XCircle size={14} />
                    {ghError}
                  </div>
                )}
                <p className="text-xs text-text-tertiary">
                  Run{' '}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-accent">
                    gh auth login
                  </code>{' '}
                  in your terminal, then check again.
                </p>
              </div>
            )}
          </div>
        )}

        {gitProvider === 'ado' && (
          <>
            <Field
              label="Organisation URL"
              value={settings.adoOrganizationUrl ?? ''}
              onChange={(v) => draft.update('adoOrganizationUrl', v)}
              placeholder="https://dev.azure.com/your-org"
              saveKey="adoOrganizationUrl"
            />
            <Field
              label="Personal Access Token"
              value={settings.adoPat ?? ''}
              onChange={(v) => draft.update('adoPat', v)}
              type="password"
              saveKey="adoPat"
            />
            <p className="text-xs text-text-tertiary">
              These credentials are shared with Work Items if you also use ADO there.
            </p>
          </>
        )}

        <CredentialSaveControls keys={GIT_KEYS} />

        <TestButton
          status={gitStatus}
          onClick={testGit}
          savingCredentials={savingForTest === 'testing' && gitStatus === 'testing'}
        />
      </SettingsPanel>
    </>
  );
}
