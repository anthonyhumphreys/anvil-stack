import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import {
  Bot,
  ClipboardCheck,
  Cloud,
  FolderGit2,
  Layers,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppSettings, Feature } from '../../../shared/types';
import {
  DOCS_CREDENTIAL_KEYS,
  GIT_CREDENTIAL_KEYS,
  PROVIDER_CREDENTIAL_KEYS,
  WORK_ITEM_CREDENTIAL_KEYS,
} from './settings-keys';

/**
 * Category registry for Settings (ST4/ST6/ST7).
 *
 * Each entry is a lazily-mounted component — only the active category mounts.
 * Panel metadata (`panels`) powers ⌘F search and `#panel` deep-link anchors;
 * keep it in sync with the `panelId` props each category renders.
 */

export interface SettingsPanelMeta {
  /** Anchor id — deep-linked as `/settings/:category#<id>`. */
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
}

export interface SettingsCategoryMeta {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  keywords?: string[];
  panels: SettingsPanelMeta[];
  /**
   * Credential keys owned by this category's forms. The shell uses them for
   * the "Discard changes?" navigation guard (ST5) — leaving the category with
   * these dirty asks first.
   */
  credentialKeys?: ReadonlyArray<keyof AppSettings>;
  /**
   * When the whole category backs a role-gated feature (ST8), the shell
   * renders a "Hidden by your role" notice instead of the panels unless the
   * user has enabled "Show all tools".
   */
  feature?: Feature;
  component: LazyExoticComponent<ComponentType>;
}

const ProfileCategory = lazy(() =>
  import('./categories/ProfileCategory').then((module) => ({
    default: module.ProfileCategory,
  })),
);
const ProvidersCategory = lazy(() =>
  import('./categories/ProvidersCategory').then((module) => ({
    default: module.ProvidersCategory,
  })),
);
const AgentsCategory = lazy(() =>
  import('./categories/AgentsCategory').then((module) => ({
    default: module.AgentsCategory,
  })),
);
const DeliveryCategory = lazy(() =>
  import('./categories/DeliveryCategory').then((module) => ({
    default: module.DeliveryCategory,
  })),
);
const ReviewCategory = lazy(() =>
  import('./categories/ReviewCategory').then((module) => ({
    default: module.ReviewCategory,
  })),
);
const DevicesCategory = lazy(() =>
  import('./categories/DevicesCategory').then((module) => ({
    default: module.DevicesCategory,
  })),
);
const SyncCategory = lazy(() =>
  import('./categories/SyncCategory').then((module) => ({ default: module.SyncCategory })),
);
const PrivacyCategory = lazy(() =>
  import('./categories/PrivacyCategory').then((module) => ({
    default: module.PrivacyCategory,
  })),
);
const WorkspaceCategory = lazy(() =>
  import('./categories/WorkspaceCategory').then((module) => ({
    default: module.WorkspaceCategory,
  })),
);
const DangerCategory = lazy(() =>
  import('./categories/DangerCategory').then((module) => ({ default: module.DangerCategory })),
);

export const SETTINGS_CATEGORIES: SettingsCategoryMeta[] = [
  {
    id: 'profile',
    label: 'Profile & appearance',
    description: 'Role, visible tools, and theme.',
    icon: UserRound,
    panels: [
      {
        id: 'role',
        title: 'Role',
        description: 'Controls which tools are visible in the sidebar.',
        keywords: ['role', 'developer', 'ba', 'brm', 'design', 'itsm', 'hidden tools'],
      },
      {
        id: 'theme',
        title: 'Theme',
        description: 'Pick the colour mood for the app.',
        keywords: ['theme', 'dark', 'light', 'appearance', 'colour', 'color'],
      },
    ],
    component: ProfileCategory,
  },
  {
    id: 'providers',
    label: 'Providers & models',
    description: 'Primary agent, model selection, reasoning, and local routing.',
    icon: SlidersHorizontal,
    keywords: ['ai', 'llm', 'model', 'codex', 'cursor', 'devin', 'openai', 'azure', 'llmgateway'],
    panels: [
      {
        id: 'agent-providers',
        title: 'Agent providers',
        description: 'Primary agent and active providers.',
        keywords: ['codex', 'cursor', 'devin', 'openai', 'azure', 'llmgateway', 'api key'],
      },
      {
        id: 'model',
        title: 'Model & reasoning',
        description: 'Primary model, reasoning effort, and agent concurrency.',
        keywords: ['model', 'reasoning', 'effort', 'threads', 'gpt'],
      },
      {
        id: 'local-model',
        title: 'Local model',
        description: 'Route simple prompts through a local model.',
        keywords: ['ollama', 'lm studio', 'apple intelligence', 'local'],
      },
      {
        id: 'thread-assist',
        title: 'Thread assistance',
        description: 'Generated thread titles and summaries.',
        keywords: ['title', 'summary', 'thread'],
      },
    ],
    credentialKeys: PROVIDER_CREDENTIAL_KEYS,
    component: ProvidersCategory,
  },
  {
    // ST9 / first-plan S3+4.1: workspace-scoped settings — name, repo
    // management, integration pointers, and the per-workspace chat access
    // default consumed by `useThreadAccess`.
    id: 'workspace',
    label: 'Workspace',
    description: 'Active workspace name, repositories, connections, and chat defaults.',
    icon: Layers,
    keywords: ['workspace', 'repos', 'repositories', 'index', 'access', 'chat access'],
    panels: [
      {
        id: 'workspace',
        title: 'Workspace',
        description: 'Name of the active workspace.',
        keywords: ['workspace', 'name', 'rename'],
      },
      {
        id: 'repositories',
        title: 'Repositories',
        description: 'Repositories in this workspace — add, remove, re-index.',
        keywords: ['repo', 'repository', 'index', 're-index', 'remove', 'forget'],
      },
      {
        id: 'chat-access',
        title: 'Chat access default',
        description: 'Access level new threads in this workspace start with.',
        keywords: ['access', 'sandbox', 'approve', 'read only', 'full access', 'codex mode'],
      },
      {
        id: 'connections',
        title: 'Connections & preferences',
        description: 'Links to the integration panels this workspace uses.',
        keywords: ['work items', 'docs', 'confluence', 'git', 'credentials'],
      },
    ],
    component: WorkspaceCategory,
  },
  {
    id: 'agents',
    label: 'Agents & skills',
    description: 'Skills, MCPs, usage, custom agents, and agent instructions.',
    icon: Bot,
    keywords: ['ai', 'agents', 'skills', 'mcp', 'codex'],
    panels: [
      {
        id: 'codex-registry',
        title: 'Codex Registry',
        description: 'Skills and MCP servers.',
        keywords: ['skills', 'mcp', 'registry'],
      },
      {
        id: 'codex-usage',
        title: 'Codex usage',
        description: 'Account usage and quota windows.',
        keywords: ['quota', 'usage', 'tokens', 'limits'],
      },
      {
        id: 'codex-agents-md',
        title: 'Personal Codex instructions',
        description: 'Global AGENTS.md read from your home configuration.',
        keywords: ['agents.md', 'instructions'],
      },
      {
        id: 'anvil-cloud',
        title: 'Anvil Cloud',
        description: 'Cloud workbench, Cell checks, and Lens.',
        keywords: ['cloud', 'lens', 'cell'],
      },
      {
        id: 'custom-agents',
        title: 'Custom agents',
        description: 'User-defined agents usable anywhere personas are selected.',
        keywords: ['persona', 'custom agent'],
      },
    ],
    component: AgentsCategory,
  },
  {
    id: 'delivery',
    label: 'Delivery integrations',
    description: 'Work items, docs, Git, and remote credentials.',
    icon: FolderGit2,
    keywords: ['integrations', 'credentials'],
    panels: [
      {
        id: 'work-items',
        title: 'Work Items',
        description: 'Backlog and issue connections (ADO, Linear, Jira).',
        keywords: ['ado', 'azure devops', 'linear', 'jira', 'tickets', 'backlog'],
      },
      {
        id: 'docs',
        title: 'Documentation',
        description: 'Confluence and Notion documentation providers.',
        keywords: ['confluence', 'notion', 'docs'],
      },
      {
        id: 'git',
        title: 'Git provider',
        description: 'Credentials used to browse and clone remote repositories.',
        keywords: ['github', 'ado', 'clone', 'pat'],
      },
    ],
    credentialKeys: [...WORK_ITEM_CREDENTIAL_KEYS, ...DOCS_CREDENTIAL_KEYS, ...GIT_CREDENTIAL_KEYS],
    component: DeliveryCategory,
  },
  {
    id: 'review',
    label: 'Review defaults',
    description: 'Rubrics used by code review workflows.',
    icon: ClipboardCheck,
    feature: 'codereview',
    panels: [
      {
        id: 'rubrics',
        title: 'Code review rubrics',
        description: 'Custom review criteria per review mode.',
        keywords: ['rubric', 'review', 'criteria'],
      },
    ],
    component: ReviewCategory,
  },
  {
    id: 'devices',
    label: 'Devices & system',
    description: 'Repo defaults and mobile companion access.',
    icon: MonitorSmartphone,
    panels: [
      {
        id: 'general',
        title: 'General',
        description: 'Defaults used when the app needs a local repository location.',
        keywords: ['repo path', 'default'],
      },
      {
        id: 'mobile',
        title: 'Mobile companion',
        description: 'Pair phones, widgets, Raycast, watch, and the menu bar.',
        keywords: ['mobile', 'raycast', 'watch', 'widget', 'pairing', 'qr'],
      },
    ],
    component: DevicesCategory,
  },
  {
    id: 'sync',
    label: 'Sync & Mesh',
    description: 'Keep state in step and run jobs on trusted devices.',
    icon: Cloud,
    keywords: ['sync', 'mesh', 'devices', 'environments', 'cloud environments'],
    panels: [
      {
        id: 'sync-mesh',
        title: 'Sync & Mesh',
        description: 'Backend connection, enrolled devices, and cloud environments.',
        keywords: ['sync', 'mesh', 'environments', 'devices', 'security'],
      },
    ],
    component: SyncCategory,
  },
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Optional crash reporting.',
    icon: ShieldCheck,
    panels: [
      {
        id: 'telemetry',
        title: 'Help improve Anvil',
        description: 'Crash reporting.',
        keywords: ['telemetry', 'crash', 'sentry', 'privacy'],
      },
    ],
    component: PrivacyCategory,
  },
  {
    id: 'danger',
    label: 'Danger area',
    description: 'Reset setup state and workspace selections.',
    icon: ShieldAlert,
    panels: [
      {
        id: 'reset',
        title: 'Reset onboarding',
        description: 'Clear first-run setup state and workspace selections.',
        keywords: ['reset', 'onboarding', 'danger'],
      },
    ],
    component: DangerCategory,
  },
];

/** Categories that existed before the "AI & agents" split, kept as aliases. */
const CATEGORY_ALIASES: Record<string, string> = {
  ai: 'providers',
};

export function getSettingsCategory(id: string): SettingsCategoryMeta | undefined {
  return SETTINGS_CATEGORIES.find((category) => category.id === id);
}

export function resolveSettingsCategoryId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (getSettingsCategory(id)) return id;
  const alias = CATEGORY_ALIASES[id];
  return alias && getSettingsCategory(alias) ? alias : undefined;
}
