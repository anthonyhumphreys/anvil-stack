import type { AppSettings } from '../../../shared/types';

/**
 * Credential keys owned by each settings panel. Kept in a standalone module so
 * the registry and shell can map dirty keys → category without eagerly loading
 * the (lazy) category components.
 *
 * A panel's Test button saves only its own list before calling the backend
 * (ST2); the "Discard changes?" navigation guard discards only the active
 * category's list (ST5).
 */

export const PROVIDER_CREDENTIAL_KEYS = [
  'openaiApiKey',
  'llmGatewayApiKey',
  'llmGatewayBillingMode',
] as const satisfies ReadonlyArray<keyof AppSettings>;

export const WORK_ITEM_CREDENTIAL_KEYS = [
  'workItemProvider',
  'workItemConnections',
  'activeWorkItemConnectionId',
  'adoOrganizationUrl',
  'adoProject',
  'adoTeam',
  'adoPat',
  'linearApiKey',
  'linearTeamId',
  'jiraHost',
  'jiraAuthMode',
  'jiraProject',
  'jiraBoardId',
  'jiraAcceptanceCriteriaField',
  'jiraEmail',
  'jiraApiToken',
] as const satisfies ReadonlyArray<keyof AppSettings>;

export const DOCS_CREDENTIAL_KEYS = [
  'docsProvider',
  'confluenceBaseUrl',
  'confluenceSpaceKey',
  'confluencePat',
  'notionDatabaseId',
] as const satisfies ReadonlyArray<keyof AppSettings>;

export const GIT_CREDENTIAL_KEYS = [
  'adoOrganizationUrl',
  'adoPat',
] as const satisfies ReadonlyArray<keyof AppSettings>;
