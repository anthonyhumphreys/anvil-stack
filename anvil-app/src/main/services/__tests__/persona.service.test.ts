import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RepoRow = {
  id: string;
  name: string;
  path: string;
  default_branch: string;
};

type RepoSummaryRow = {
  repo_id: string;
  overview: string | null;
  language_breakdown: string | null;
};

type ModuleSummaryRow = {
  repo_id: string;
  path: string;
  purpose: string | null;
};

const { loadPromptTemplate, dbState } = vi.hoisted(() => ({
  loadPromptTemplate: vi.fn((templateName: string, variables: Record<string, string>) =>
    JSON.stringify({ templateName, variables }),
  ),
  dbState: {
    repos: new Map<string, RepoRow>(),
    repoSummaries: new Map<string, RepoSummaryRow>(),
    moduleSummaries: new Map<string, ModuleSummaryRow[]>(),
  },
}));

const { getDbInsightsPersonaSummary } = vi.hoisted(() => ({
  getDbInsightsPersonaSummary: vi.fn(() => 'No DB Insights analysis is available yet.'),
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: (query: string) => {
      if (query.includes('SELECT * FROM repos WHERE id = ?')) {
        return {
          get: (repoId: string) => dbState.repos.get(repoId),
        };
      }

      if (query.includes('SELECT name FROM repos WHERE id = ?')) {
        return {
          get: (repoId: string) => {
            const repo = dbState.repos.get(repoId);
            return repo ? { name: repo.name } : undefined;
          },
        };
      }

      if (query.includes('SELECT * FROM repo_summaries WHERE repo_id = ?')) {
        return {
          get: (repoId: string) => dbState.repoSummaries.get(repoId),
        };
      }

      if (query.includes('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')) {
        return {
          all: (repoId: string) => dbState.moduleSummaries.get(repoId) ?? [],
        };
      }

      throw new Error(`Unexpected query in persona.service test: ${query}`);
    },
  }),
}));

vi.mock('../../utils/prompt-templates.js', () => ({
  loadPromptTemplate,
}));

vi.mock('../db-insights.service.js', () => ({
  getDbInsightsPersonaSummary,
}));

import { buildDesignSystemPrompt, buildSystemPrompt, getPersonas } from '../persona.service.js';

let repoDir = '';

beforeEach(() => {
  loadPromptTemplate.mockClear();
  getDbInsightsPersonaSummary.mockClear();
  dbState.repos.clear();
  dbState.repoSummaries.clear();
  dbState.moduleSummaries.clear();

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-persona-'));
  fs.writeFileSync(
    path.join(repoDir, 'AGENTS.md'),
    [
      '# Repo Guide',
      '',
      '## Coding Conventions',
      '- Prefer targeted tests',
      '- Keep service logic out of the UI layer',
      '',
      '## Other',
      'Ignored for this test',
    ].join('\n'),
  );

  dbState.repos.set('repo-1', {
    id: 'repo-1',
    name: 'Mentor Repo',
    path: repoDir,
    default_branch: 'main',
  });

  dbState.repoSummaries.set('repo-1', {
    repo_id: 'repo-1',
    overview: 'Electron app with a chat surface and main-process services.',
    language_breakdown: JSON.stringify([{ language: 'TypeScript', percentage: 92 }]),
  });

  dbState.moduleSummaries.set('repo-1', [
    {
      repo_id: 'repo-1',
      path: 'src/main/services/chat.service.ts',
      purpose: 'Coordinates chat workflows.',
    },
  ]);
});

afterEach(() => {
  if (repoDir) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('getPersonas', () => {
  it('includes the Dev Mentor persona', () => {
    expect(getPersonas()).toContainEqual(
      expect.objectContaining({
        id: 'mentor',
        name: 'Dev Mentor',
        icon: 'GraduationCap',
        description:
          'Guides junior developers through multiple approaches, optimisation tradeoffs, and debugging steps.',
        systemPromptTemplate: 'personas/mentor.md',
      }),
    );
  });

  it('includes the DB Expert persona', () => {
    expect(getPersonas()).toContainEqual(
      expect.objectContaining({
        id: 'db-expert',
        name: 'DB Expert',
        icon: 'Database',
        description: 'Explains schemas, stored procedures, and SQL Server database design.',
        systemPromptTemplate: 'personas/db-expert.md',
      }),
    );
  });
});

describe('buildSystemPrompt', () => {
  it('uses the mentor prompt template with repo context variables', () => {
    const prompt = buildSystemPrompt('mentor', 'repo-1');

    expect(loadPromptTemplate).toHaveBeenCalledWith(
      'personas/mentor.md',
      expect.objectContaining({
        repoName: 'Mentor Repo',
        primaryLanguage: 'TypeScript',
        architectureDescription: 'Electron app with a chat surface and main-process services.',
        conventions: expect.stringContaining('Prefer targeted tests'),
        moduleSummaries: expect.stringContaining('src/main/services/chat.service.ts'),
      }),
    );
    expect(prompt).toContain('"templateName":"personas/mentor.md"');
  });

  it('falls back to workspace-document guidance when no repos are attached', () => {
    const prompt = buildSystemPrompt('ba', []);

    expect(loadPromptTemplate).toHaveBeenCalledWith(
      'personas/ba.md',
      expect.objectContaining({
        repoName: 'Workspace documents and requirements',
        architectureDescription: expect.stringContaining('No repositories are attached'),
        conventions: expect.stringContaining('No AGENTS.md is available yet'),
      }),
    );
    expect(prompt).toContain('"templateName":"personas/ba.md"');
  });

  it('injects DB Insights workspace context for the DB Expert persona', () => {
    getDbInsightsPersonaSummary.mockReturnValueOnce(
      'Latest DB Insights analysis for this workspace (FinanceDb).',
    );

    const prompt = buildSystemPrompt('db-expert', [], 'workspace-1');

    expect(getDbInsightsPersonaSummary).toHaveBeenCalledWith('workspace-1');
    expect(loadPromptTemplate).toHaveBeenCalledWith(
      'personas/db-expert.md',
      expect.objectContaining({
        dbInsightsSummary: 'Latest DB Insights analysis for this workspace (FinanceDb).',
      }),
    );
    expect(prompt).toContain('"templateName":"personas/db-expert.md"');
  });

  it('documents the mentor-specific discovery and escalation workflow', () => {
    const mentorPrompt = fs.readFileSync(
      path.resolve(process.cwd(), 'prompts/personas/mentor.md'),
      'utf-8',
    );

    expect(mentorPrompt).toContain('full brainstorming and discovery phase');
    expect(mentorPrompt).toContain('`scaffold-project` skill');
    expect(mentorPrompt).toContain('`bootstrap` skill');
    expect(mentorPrompt).toContain('Do not invoke the `answers` skill autonomously.');
    expect(mentorPrompt).toContain('same issue 3 or more times');
    expect(mentorPrompt).toContain('benefits and drawbacks');
    expect(mentorPrompt).toContain('alternative method');
  });
});

describe('buildDesignSystemPrompt', () => {
  it('injects Figma Make context and resource guidance into the design prompt', () => {
    const prompt = buildDesignSystemPrompt(
      'repo-1',
      'implement',
      '[Figma context links]\n- Figma Make project: https://figma.com/make/make123/App',
    );

    expect(loadPromptTemplate).toHaveBeenCalledWith(
      'personas/design.md',
      expect.objectContaining({
        figmaContext: expect.stringContaining('Figma Make project'),
        designMode: expect.stringContaining('MCP resources'),
      }),
    );
    expect(prompt).toContain('"templateName":"personas/design.md"');
  });
});
