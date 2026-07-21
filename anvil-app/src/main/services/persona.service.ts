import fs from 'node:fs';
import path from 'node:path';
import type { Persona, WorkItem, DesignMode } from '../../shared/types.js';
import { PRIMARY_SCAFFOLD_COMPLETE_MARKER } from '../../shared/app-identity.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { getDb } from '../db/database.js';
import { getDbInsightsPersonaSummary } from './db-insights.service.js';

const PERSONAS: Persona[] = [
  {
    id: 'coder',
    name: 'Coder',
    icon: 'Code',
    colour: '#22c55e',
    description: 'General purpose coding agent. Writes, edits, and runs code.',
    systemPromptTemplate: 'personas/coder.md',
    capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
  },
  {
    id: 'mentor',
    name: 'Dev Mentor',
    icon: 'GraduationCap',
    colour: '#0f766e',
    description:
      'Guides junior developers through multiple approaches, optimisation tradeoffs, and debugging steps.',
    systemPromptTemplate: 'personas/mentor.md',
    capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
  },
  {
    id: 'architect',
    name: 'Architect',
    icon: 'Building2',
    colour: '#3b82f6',
    description: 'Analyses structure and design. Does not modify code.',
    systemPromptTemplate: 'personas/architect.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'security',
    name: 'Security',
    icon: 'Shield',
    colour: '#ef4444',
    description: 'Scans for vulnerabilities. Can run analysis tools but does not edit code.',
    systemPromptTemplate: 'personas/security.md',
    capabilities: { canWriteFiles: false, canRunCommands: true, canReadFiles: true },
  },
  {
    id: 'reviewer',
    name: 'Code Reviewer',
    icon: 'Eye',
    colour: '#eab308',
    description: 'Reviews code against conventions and best practices.',
    systemPromptTemplate: 'personas/reviewer.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'docs',
    name: 'Documentation',
    icon: 'BookOpen',
    colour: '#8b5cf6',
    description: 'Writes and updates documentation files only.',
    systemPromptTemplate: 'personas/docs.md',
    capabilities: { canWriteFiles: true, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'ba',
    name: 'Business Analyst',
    icon: 'ClipboardList',
    colour: '#7c3aed',
    description:
      'Analyse requirements, assess feasibility, flag compliance concerns, create spikes.',
    systemPromptTemplate: 'personas/ba.md',
    capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
  },
  {
    id: 'workshop-planner',
    name: 'Workshop Planner',
    icon: 'Presentation',
    colour: '#f97316',
    description:
      'Plans discovery sessions, stakeholder workshops, agendas, decision framing, and facilitation outputs.',
    systemPromptTemplate: 'personas/workshop-planner.md',
    capabilities: { canWriteFiles: true, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'service-desk',
    name: 'Service Desk Analyst',
    icon: 'Headphones',
    colour: '#38bdf8',
    description: 'Structures first-line intake, troubleshooting, classification, and handover.',
    systemPromptTemplate: 'personas/service-desk.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'technical-support',
    name: 'Technical Support Analyst',
    icon: 'Wrench',
    colour: '#2dd4bf',
    description: 'Investigates technical evidence and prepares clear second-line escalations.',
    systemPromptTemplate: 'personas/technical-support.md',
    capabilities: { canWriteFiles: false, canRunCommands: true, canReadFiles: true },
  },
  {
    id: 'incident-manager',
    name: 'Incident Manager',
    icon: 'Radio',
    colour: '#fb7185',
    description: 'Coordinates restoration, decisions, timelines, ownership, and communications.',
    systemPromptTemplate: 'personas/incident-manager.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'problem-manager',
    name: 'Problem Manager',
    icon: 'SearchCheck',
    colour: '#c084fc',
    description: 'Separates symptoms from causes and develops evidence-backed corrective actions.',
    systemPromptTemplate: 'personas/problem-manager.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'change-manager',
    name: 'Change Manager',
    icon: 'GitPullRequest',
    colour: '#fbbf24',
    description: 'Assesses change risk, dependencies, validation, approvals, and backout plans.',
    systemPromptTemplate: 'personas/change-manager.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'service-manager',
    name: 'Service Manager',
    icon: 'Gauge',
    colour: '#a3e635',
    description: 'Prepares service reviews, measures outcomes, and shapes continual improvement.',
    systemPromptTemplate: 'personas/service-manager.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'design',
    name: 'Design Companion',
    icon: 'Palette',
    colour: '#ec4899',
    description: 'Design with Figma or implement designs into code.',
    systemPromptTemplate: 'personas/design.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
  {
    id: 'db-expert',
    name: 'DB Expert',
    icon: 'Database',
    colour: '#14b8a6',
    description: 'Explains schemas, stored procedures, and SQL Server database design.',
    systemPromptTemplate: 'personas/db-expert.md',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
];

export function getPersonas(): Persona[] {
  return PERSONAS;
}

export function getPersonaById(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}

/**
 * Build the enriched system prompt for a persona + repo combination.
 * Injects repo context, AGENTS.md content, module summaries, etc.
 */
export function buildSystemPrompt(
  personaId: string,
  repoIds: string | string[],
  workspaceId?: string,
  repoPathOverrides?: Record<string, string>,
): string {
  const persona = getPersonaById(personaId);
  if (!persona) throw new Error(`Unknown persona: ${personaId}`);
  const dbInsightsSummary =
    personaId === 'db-expert'
      ? getDbInsightsPersonaSummary(workspaceId)
      : 'DB Insights context is only injected for the DB Expert persona.';

  const ids = Array.isArray(repoIds) ? repoIds : [repoIds];
  if (ids.length === 0) {
    return loadPromptTemplate(persona.systemPromptTemplate, {
      repoName: 'Workspace documents and requirements',
      primaryLanguage: 'Unknown',
      architectureDescription:
        'No repositories are attached to this workspace yet. Work from uploaded documentation, governance files, and the user conversation.',
      conventions:
        'No AGENTS.md is available yet. Be explicit about assumptions and avoid claiming repo-backed facts you cannot inspect.',
      moduleSummaries: 'No modules analysed yet.',
      workItems: 'No active work items linked.',
      dbInsightsSummary,
    });
  }

  const db = getDb();

  // Gather context from all repos
  const repoContexts: string[] = [];
  let firstRepoName = '';
  let firstPrimaryLanguage = 'Unknown';
  let firstArchitecture = 'No architecture analysis available yet. Run indexing first.';
  let allConventions = 'No AGENTS.md found — follow existing patterns in the codebase.';
  let allModules = '';

  for (const repoId of ids) {
    const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
      | { name: string; path: string; default_branch: string }
      | undefined;
    if (!repoRow) continue;

    const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
      | { overview: string | null; language_breakdown: string | null }
      | undefined;

    const moduleRows = db
      .prepare('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')
      .all(repoId) as { path: string; purpose: string | null }[];

    let primaryLanguage = 'Unknown';
    if (summaryRow?.language_breakdown) {
      try {
        const langs = JSON.parse(summaryRow.language_breakdown) as {
          language: string;
          percentage: number;
        }[];
        if (langs.length > 0) primaryLanguage = langs[0].language;
      } catch {
        /* ignore */
      }
    }

    // Read AGENTS.md
    let conventions = '';
    const agentsMdPath = path.join(repoRow.path, 'AGENTS.md');
    if (fs.existsSync(agentsMdPath)) {
      try {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        const conventionsMatch = content.match(/## Coding Conventions\n([\s\S]*?)(?=\n## |$)/);
        conventions = conventionsMatch ? conventionsMatch[1].trim() : content.slice(0, 2000);
      } catch {
        /* ignore */
      }
    }

    const moduleSummaries = moduleRows
      .map((m) => `- **${m.path}**: ${m.purpose ?? 'No description'}`)
      .join('\n');

    // Store first repo values for template variables (backwards compatibility)
    if (!firstRepoName) {
      firstRepoName = repoRow.name;
      firstPrimaryLanguage = primaryLanguage;
      firstArchitecture = summaryRow?.overview ?? firstArchitecture;
      if (conventions) allConventions = conventions;
      allModules = moduleSummaries;
    }

    // Build per-repo context block
    const overview = summaryRow?.overview ?? 'Not indexed yet.';
    repoContexts.push(
      `### ${repoRow.name} (${primaryLanguage})\n` +
        `Path: ${repoPathOverrides?.[repoId] ?? repoRow.path}\n` +
        `Overview: ${overview}\n` +
        (moduleSummaries ? `Modules:\n${moduleSummaries}` : ''),
    );
  }

  // For multi-repo sessions, override the architecture description with all repo contexts
  const isMultiRepo = ids.length > 1;
  const architectureDescription = isMultiRepo
    ? `You have access to ${ids.length} repositories:\n\n${repoContexts.join('\n\n')}`
    : firstArchitecture;
  const repoName = isMultiRepo
    ? `${ids.length} repositories (${repoContexts
        .map((_, i) => {
          const row = db.prepare('SELECT name FROM repos WHERE id = ?').get(ids[i]) as
            | { name: string }
            | undefined;
          return row?.name ?? ids[i];
        })
        .join(', ')})`
    : firstRepoName;

  const variables: Record<string, string> = {
    repoName,
    primaryLanguage: firstPrimaryLanguage,
    architectureDescription,
    conventions: allConventions,
    moduleSummaries: allModules || 'No modules analysed yet.',
    workItems: 'No active work items linked.',
    dbInsightsSummary,
  };

  return loadPromptTemplate(persona.systemPromptTemplate, variables);
}

export function buildScaffoldSystemPrompt(personaId: string, rootPath: string): string {
  const persona = getPersonaById(personaId);
  if (!persona) throw new Error(`Unknown persona: ${personaId}`);

  const basePrompt = loadPromptTemplate(persona.systemPromptTemplate, {
    repoName: 'Workspace scaffold root',
    primaryLanguage: 'Unknown',
    architectureDescription: `You are scaffolding new repositories under this root path: ${rootPath}`,
    conventions:
      'No AGENTS.md exists yet. Create sensible project defaults and explain important choices.',
    moduleSummaries: 'No modules analysed yet.',
    workItems: 'No active work items linked.',
  });

  return [
    basePrompt,
    '## Scaffold Mode',
    `- Your current working directory is the parent scaffold folder: ${rootPath}`,
    '- Ask the user to name the repositories you should create before scaffolding them.',
    '- Create all requested repositories underneath the scaffold root.',
    '- Use the scaffold-project skill when initializing each new repository.',
    '- Do not claim success until the repositories have been created and scaffolded.',
    '- When the scaffold work is complete, end your final assistant response with this exact machine-readable block:',
    `[[${PRIMARY_SCAFFOLD_COMPLETE_MARKER}]]`,
    '{"repos":[{"name":"example-repo","path":"/absolute/path/to/example-repo"}]}',
    `[[/${PRIMARY_SCAFFOLD_COMPLETE_MARKER}]]`,
  ].join('\n');
}

/**
 * Build the enriched system prompt for the BA persona, injecting work item context.
 */
export function buildBaSystemPrompt(repoId: string, workItem: WorkItem): string {
  const db = getDb();

  // Fetch repo info
  const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
    | { name: string; path: string; default_branch: string }
    | undefined;
  if (!repoRow) throw new Error(`Repo not found: ${repoId}`);

  // Fetch cached summary
  const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
    | {
        overview: string | null;
        architecture_description: string | null;
        language_breakdown: string | null;
        frameworks: string | null;
      }
    | undefined;

  // Fetch module summaries
  const moduleRows = db
    .prepare('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')
    .all(repoId) as { path: string; purpose: string | null }[];

  // Detect primary language from breakdown
  let primaryLanguage = 'Unknown';
  if (summaryRow?.language_breakdown) {
    try {
      const langs = JSON.parse(summaryRow.language_breakdown) as {
        language: string;
        percentage: number;
      }[];
      if (langs.length > 0) primaryLanguage = langs[0].language;
    } catch {
      /* ignore */
    }
  }

  // Try to read AGENTS.md from the repo for conventions
  let conventions = 'No AGENTS.md found — follow existing patterns in the codebase.';
  const agentsMdPath = path.join(repoRow.path, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) {
    try {
      const content = fs.readFileSync(agentsMdPath, 'utf-8');
      const conventionsMatch = content.match(/## Coding Conventions\n([\s\S]*?)(?=\n## |$)/);
      conventions = conventionsMatch ? conventionsMatch[1].trim() : content.slice(0, 3000);
    } catch {
      /* ignore read errors */
    }
  }

  const moduleSummariesText = moduleRows
    .map((m) => `- **${m.path}**: ${m.purpose ?? 'No description'}`)
    .join('\n');

  const architectureDescription =
    summaryRow?.overview ?? 'No architecture analysis available yet. Run indexing first.';

  // Build work item context block
  const lines: string[] = [
    `- **ID**: ${workItem.id}`,
    `- **Title**: ${workItem.title}`,
    `- **Type**: ${workItem.type}`,
    `- **State**: ${workItem.state}`,
    `- **Priority**: ${workItem.priority}`,
  ];
  if (workItem.assignee) lines.push(`- **Assignee**: ${workItem.assignee}`);
  if (workItem.iterationPath) lines.push(`- **Iteration**: ${workItem.iterationPath}`);
  if (workItem.tags && workItem.tags.length > 0)
    lines.push(`- **Tags**: ${workItem.tags.join(', ')}`);
  if (workItem.parentId) lines.push(`- **Parent ID**: ${workItem.parentId}`);
  if (workItem.url) lines.push(`- **URL**: ${workItem.url}`);
  if (workItem.description) lines.push(`\n**Description**:\n${workItem.description}`);
  if (workItem.acceptanceCriteria)
    lines.push(`\n**Acceptance Criteria**:\n${workItem.acceptanceCriteria}`);
  if (workItem.children && workItem.children.length > 0) {
    const childList = workItem.children
      .map((c) => `  - [${c.id}] ${c.title} (${c.state})`)
      .join('\n');
    lines.push(`\n**Child Items**:\n${childList}`);
  }
  if (workItem.extras && Object.keys(workItem.extras).length > 0) {
    try {
      lines.push(`\n**Extra Fields**:\n${JSON.stringify(workItem.extras, null, 2)}`);
    } catch {
      /* ignore */
    }
  }
  const workItemContext = lines.join('\n');

  // Build template variables
  const variables: Record<string, string> = {
    repoName: repoRow.name,
    primaryLanguage,
    architectureDescription,
    conventions,
    moduleSummaries: moduleSummariesText || 'No modules analysed yet.',
    workItemContext,
    workItems: 'No additional active work items linked.',
  };

  return loadPromptTemplate('personas/ba.md', variables);
}

/**
 * Build the enriched system prompt for the Design Companion persona.
 * Injects mode-specific instructions and optional Figma file context.
 */
export function buildDesignSystemPrompt(
  repoIds: string | string[],
  mode: DesignMode,
  figmaContext?: string,
): string {
  const ids = Array.isArray(repoIds) ? repoIds : [repoIds];
  const db = getDb();

  const repoContexts: string[] = [];
  let firstRepoName = '';
  let firstPrimaryLanguage = 'Unknown';
  let firstArchitecture = 'No architecture analysis available yet. Run indexing first.';
  let allConventions = 'No AGENTS.md found — follow existing patterns in the codebase.';
  let allModules = '';

  for (const repoId of ids) {
    const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
      | { name: string; path: string; default_branch: string }
      | undefined;
    if (!repoRow) continue;

    const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
      | { overview: string | null; language_breakdown: string | null }
      | undefined;

    const moduleRows = db
      .prepare('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')
      .all(repoId) as { path: string; purpose: string | null }[];

    let primaryLanguage = 'Unknown';
    if (summaryRow?.language_breakdown) {
      try {
        const langs = JSON.parse(summaryRow.language_breakdown) as {
          language: string;
          percentage: number;
        }[];
        if (langs.length > 0) primaryLanguage = langs[0].language;
      } catch {
        /* ignore */
      }
    }

    let conventions = '';
    const agentsMdPath = path.join(repoRow.path, 'AGENTS.md');
    if (fs.existsSync(agentsMdPath)) {
      try {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        const conventionsMatch = content.match(/## Coding Conventions\n([\s\S]*?)(?=\n## |$)/);
        conventions = conventionsMatch ? conventionsMatch[1].trim() : content.slice(0, 2000);
      } catch {
        /* ignore */
      }
    }

    const moduleSummaries = moduleRows
      .map((m) => `- **${m.path}**: ${m.purpose ?? 'No description'}`)
      .join('\n');

    if (!firstRepoName) {
      firstRepoName = repoRow.name;
      firstPrimaryLanguage = primaryLanguage;
      firstArchitecture = summaryRow?.overview ?? firstArchitecture;
      if (conventions) allConventions = conventions;
      allModules = moduleSummaries;
    }

    repoContexts.push(
      `### ${repoRow.name} (${primaryLanguage})\n` +
        `Path: ${repoRow.path}\n` +
        `Overview: ${summaryRow?.overview ?? 'Not indexed yet.'}\n` +
        (moduleSummaries ? `Modules:\n${moduleSummaries}` : ''),
    );
  }

  const isMultiRepo = ids.length > 1;
  const architectureDescription = isMultiRepo
    ? `You have access to ${ids.length} repositories:\n\n${repoContexts.join('\n\n')}`
    : firstArchitecture;
  const repoName =
    ids.length === 0
      ? 'Workspace documents and design context'
      : isMultiRepo
        ? `${ids.length} repositories`
        : firstRepoName;

  const designModeBlock =
    mode === 'design'
      ? `You are in **Design Mode** — helping a designer work with Figma.

- You can read AND write to Figma files using the MCP tools
- For Figma Make links, use MCP resources from the official Figma MCP server before discussing behavior, styles, or prototype code
- Focus on design critique, token consistency, component organization, spacing and typography review
- Use \`use_figma\` to modify Figma files when asked
- Do NOT write code to the filesystem — suggest code patterns conversationally if asked
- Extract and report design tokens (colours, spacing, typography) when reviewing designs
- When asked to make changes, always confirm the scope before modifying the Figma file`
      : `You are in **Implement Mode** — helping a developer implement a Figma design into code.

- Use Figma MCP tools to READ designs (get_design_context, get_screenshot, get_metadata) but do NOT modify the Figma file
- For Figma Make links, use MCP resources from the official Figma MCP server to fetch the relevant project files before implementing
- Match the project's existing component library, design tokens, and conventions
- You have the frontend-design skill — use it for high-quality, production-grade frontend code
- Write implementation code to the filesystem, run build and lint commands as needed
- Always call \`get_design_context\` first to get code hints and component mappings, then adapt to the project's stack
- Prefer reusing existing components over creating new ones`;

  const variables: Record<string, string> = {
    repoName,
    primaryLanguage: firstPrimaryLanguage,
    architectureDescription,
    conventions: allConventions,
    moduleSummaries: allModules || 'No modules analysed yet.',
    figmaContext:
      figmaContext ?? 'No Figma file linked yet. The user can paste a Figma URL to get started.',
    designMode: designModeBlock,
  };

  return loadPromptTemplate('personas/design.md', variables);
}
