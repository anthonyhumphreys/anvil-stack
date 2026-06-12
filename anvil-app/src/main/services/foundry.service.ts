import type { ModuleSummary, RepoSummary } from '../../shared/types.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { callLlm, resetLlmClient } from './llm.service.js';

/** Reset client when settings change */
export function resetFoundryClient(): void {
  resetLlmClient();
}

/**
 * Summarise a single module directory. Returns structured module summary.
 */
export async function summariseModule(
  repoName: string,
  modulePath: string,
  directoryTree: string,
  keyFileContents: string,
  repoPath?: string,
  options?: { onProgress?: (message: string) => void },
): Promise<ModuleSummary> {
  const prompt = loadPromptTemplate('module-summary.md', {
    repoName,
    modulePath,
    directoryTree,
    keyFileContents,
  });

  const response = await callLlm(prompt, 2048, 0.3, 3, {
    cwd: repoPath,
    taskClass: 'long-context',
    onProgress: options?.onProgress,
  });
  const parsed = parseJsonResponse<{ purpose: string; keyFiles: string[]; dependencies: string[] }>(
    response,
  );

  return {
    path: modulePath,
    purpose: parsed.purpose ?? 'No description available',
    fileCount: 0, // filled by caller
    keyFiles: parsed.keyFiles ?? [],
    dependencies: parsed.dependencies ?? [],
  };
}

/**
 * Generate overall repo summary from module summaries and file tree.
 */
export async function summariseRepo(
  moduleSummaries: ModuleSummary[],
  fileTree: string,
  configFileContents: string,
  repoPath?: string,
  options?: { onProgress?: (message: string) => void },
): Promise<Omit<RepoSummary, 'repoId' | 'modules'>> {
  const moduleSummaryText = moduleSummaries
    .map(
      (m) =>
        `### ${m.path}\n${m.purpose}\nKey files: ${m.keyFiles.join(', ')}\nDependencies: ${m.dependencies.join(', ')}`,
    )
    .join('\n\n');

  const prompt = loadPromptTemplate('repo-summary.md', {
    fileTree,
    configFileContents,
    moduleSummaries: moduleSummaryText,
  });

  const response = await callLlm(prompt, 4096, 0.3, 3, {
    cwd: repoPath,
    taskClass: 'long-context',
    onProgress: options?.onProgress,
  });
  const parsed = parseJsonResponse<{
    overview: string;
    architectureDescription: string;
    mermaidDiagram: string;
    patterns: string[];
    frameworks: string[];
    entryPoints: string[];
    configFiles: string[];
  }>(response);

  return {
    overview: parsed.overview ?? '',
    patterns: parsed.patterns ?? [],
    frameworks: parsed.frameworks ?? [],
    entryPoints: parsed.entryPoints ?? [],
    configFiles: parsed.configFiles ?? [],
    mermaidDiagram: parsed.mermaidDiagram ?? '',
  };
}

/**
 * Generate a deep repo summary from local scan data plus Repobase-derived context.
 */
export async function summariseDeepRepo(
  repoName: string,
  fileTree: string,
  configFileContents: string,
  moduleCandidates: ModuleSummary[],
  repobaseContext: string,
  repoPath?: string,
  options?: { onProgress?: (message: string) => void },
): Promise<Omit<RepoSummary, 'repoId'>> {
  const moduleCandidateText = moduleCandidates
    .map((m) => `### ${m.path}\nFiles: ${m.fileCount}\nKey files: ${m.keyFiles.join(', ')}`)
    .join('\n\n');

  const prompt = loadPromptTemplate('deep-repo-summary.md', {
    repoName,
    fileTree,
    configFileContents,
    moduleCandidates: moduleCandidateText,
    repobaseContext,
  });

  const response = await callLlm(prompt, 4096, 0.2, 3, {
    cwd: repoPath,
    taskClass: 'long-context',
    onProgress: options?.onProgress,
  });

  const parsed = parseJsonResponse<{
    overview: string;
    architectureDescription: string;
    mermaidDiagram: string;
    patterns: string[];
    frameworks: string[];
    entryPoints: string[];
    configFiles: string[];
    modules: Array<{
      path: string;
      purpose: string;
      keyFiles: string[];
      dependencies: string[];
    }>;
  }>(response);

  return {
    overview: parsed.overview ?? '',
    patterns: parsed.patterns ?? [],
    frameworks: parsed.frameworks ?? [],
    entryPoints: parsed.entryPoints ?? [],
    configFiles: parsed.configFiles ?? [],
    mermaidDiagram: parsed.mermaidDiagram ?? '',
    modules: (parsed.modules ?? []).map((moduleCandidate) => ({
      path: moduleCandidate.path,
      purpose: moduleCandidate.purpose ?? 'No description available',
      fileCount: 0,
      keyFiles: moduleCandidate.keyFiles ?? [],
      dependencies: moduleCandidate.dependencies ?? [],
    })),
  };
}

function parseJsonResponse<T>(text: string): T {
  // Try to extract JSON from markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : text;

  try {
    return JSON.parse(jsonStr.trim());
  } catch {
    console.warn('[LLM] Failed to parse JSON response, returning raw text');
    return { overview: text } as T;
  }
}

/**
 * Generate AGENTS.md content from repo summary data.
 */
export async function generateAgentsMd(repoName: string, summary: RepoSummary): Promise<string> {
  const moduleSummaryText = summary.modules
    .map(
      (m) =>
        `### ${m.path}\n- Purpose: ${m.purpose}\n- Key files: ${m.keyFiles.join(', ')}\n- Dependencies: ${m.dependencies.join(', ')}`,
    )
    .join('\n\n');

  const prompt = loadPromptTemplate('agents-md.md', {
    repoName,
    overview: summary.overview,
    architectureDescription: summary.mermaidDiagram ? 'See mermaid diagram below' : 'Not available',
    mermaidDiagram: summary.mermaidDiagram || 'graph LR\n  A[Project] --> B[See modules below]',
    moduleSummaries: moduleSummaryText,
    patterns: summary.patterns.join(', ') || 'None detected',
    frameworks: summary.frameworks.join(', ') || 'None detected',
    entryPoints: summary.entryPoints.join(', ') || 'None detected',
    configFiles: summary.configFiles.join(', ') || 'None detected',
    date: new Date().toISOString().split('T')[0],
  });

  return callLlm(prompt, 4096, 0.4, 3, { taskClass: 'short-summary' });
}

/**
 * Generate devcontainer.json content from repo analysis.
 */
export async function generateDevcontainer(
  repoName: string,
  languages: string[],
  frameworks: string[],
  configFiles: string[],
): Promise<string> {
  const prompt = loadPromptTemplate('devcontainer.md', {
    repoName,
    languages: languages.join(', ') || 'Unknown',
    frameworks: frameworks.join(', ') || 'None detected',
    configFiles: configFiles.join(', ') || 'None',
  });

  const response = await callLlm(prompt, 2048, 0.3, 3, { taskClass: 'simple-json' });

  // Ensure valid JSON — strip code fences if present
  const fenceMatch = response.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return JSON.stringify(parsed, null, 2);
  } catch {
    return JSON.stringify(
      {
        name: repoName,
        image: 'mcr.microsoft.com/devcontainers/universal:2',
        features: {},
        customizations: {
          vscode: {
            extensions: ['ms-azuretools.vscode-docker'],
          },
        },
      },
      null,
      2,
    );
  }
}
