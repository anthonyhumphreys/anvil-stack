import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OnboardDetection, EnvironmentCheck, OnboardAction } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { analyseRepo } from './indexer.service.js';

const execFileAsync = promisify(execFile);

/**
 * Detect the onboarding state of a repository — what artifacts exist,
 * which are stale, which environment tools are installed.
 */
export async function detectOnboardState(
  repoPath: string,
  repoId: string,
): Promise<OnboardDetection> {
  const [artifacts, envChecks] = await Promise.all([
    detectArtifacts(repoPath),
    detectEnvironment(repoPath),
  ]);

  const suggestedActions = computeSuggestedActions(artifacts, envChecks);

  const detection: OnboardDetection = {
    repoId,
    agentsMdExists: artifacts.agentsMdExists,
    agentsMdPath: artifacts.agentsMdPath,
    agentsMdStaleness: artifacts.agentsMdStaleness,
    devcontainerExists: artifacts.devcontainerExists,
    devcontainerPath: artifacts.devcontainerPath,
    readmeExists: artifacts.readmeExists,
    environmentStatus: envChecks,
    suggestedActions,
  };

  // Cache in database
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO onboard_state (repo_id, detection_json, detected_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(repoId, JSON.stringify(detection));

  return detection;
}

// --- Artifact detection ---

interface ArtifactDetection {
  agentsMdExists: boolean;
  agentsMdPath?: string;
  agentsMdStaleness: 'current' | 'stale' | 'missing';
  devcontainerExists: boolean;
  devcontainerPath?: string;
  readmeExists: boolean;
}

async function detectArtifacts(repoPath: string): Promise<ArtifactDetection> {
  const result: ArtifactDetection = {
    agentsMdExists: false,
    agentsMdStaleness: 'missing',
    devcontainerExists: false,
    readmeExists: false,
  };

  // Check AGENTS.md
  const agentsPath = path.join(repoPath, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    result.agentsMdExists = true;
    result.agentsMdPath = agentsPath;
    result.agentsMdStaleness = await checkAgentsMdStaleness(repoPath, agentsPath);
  }

  // Check devcontainer
  const devcontainerPath = path.join(repoPath, '.devcontainer', 'devcontainer.json');
  if (fs.existsSync(devcontainerPath)) {
    result.devcontainerExists = true;
    result.devcontainerPath = devcontainerPath;
  }

  // Check README
  const readmePaths = ['README.md', 'README.rst', 'README.txt', 'README'];
  for (const name of readmePaths) {
    if (fs.existsSync(path.join(repoPath, name))) {
      result.readmeExists = true;
      break;
    }
  }

  return result;
}

/**
 * Check if AGENTS.md is stale by comparing its mtime to the most recent commit.
 */
async function checkAgentsMdStaleness(
  repoPath: string,
  agentsPath: string,
): Promise<'current' | 'stale'> {
  try {
    const agentsMtime = fs.statSync(agentsPath).mtime;

    // Get last commit date
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI'], {
      cwd: repoPath,
    });
    const lastCommitDate = new Date(stdout.trim());

    // If last commit is more than 7 days newer than AGENTS.md, consider stale
    const diffDays = (lastCommitDate.getTime() - agentsMtime.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > 7 ? 'stale' : 'current';
  } catch {
    return 'current'; // If we can't determine, assume current
  }
}

// --- Environment detection ---

/** Language/framework → required tools mapping */
const TOOL_CHECKS: Record<
  string,
  { name: string; commands: string[]; required: boolean; installHint?: string }[]
> = {
  'Node.js': [
    {
      name: 'Node.js',
      commands: ['node --version'],
      required: true,
      installHint: 'https://nodejs.org or `nvm install --lts`',
    },
    { name: 'npm', commands: ['npm --version'], required: true },
  ],
  TypeScript: [
    {
      name: 'TypeScript Compiler',
      commands: ['npx tsc --version', 'tsc --version'],
      required: false,
    },
  ],
  '.NET': [
    {
      name: '.NET SDK',
      commands: ['dotnet --version'],
      required: true,
      installHint: 'https://dot.net/download',
    },
  ],
  Python: [
    {
      name: 'Python 3',
      commands: ['python3 --version', 'python --version'],
      required: true,
      installHint: 'https://python.org/downloads',
    },
    { name: 'pip', commands: ['pip3 --version', 'pip --version'], required: true },
  ],
  Go: [{ name: 'Go', commands: ['go version'], required: true, installHint: 'https://go.dev/dl/' }],
  Rust: [
    {
      name: 'Rust (rustc)',
      commands: ['rustc --version'],
      required: true,
      installHint: 'https://rustup.rs',
    },
    { name: 'Cargo', commands: ['cargo --version'], required: true },
  ],
  'Java (Maven)': [
    { name: 'Java JDK', commands: ['java --version', 'java -version'], required: true },
    { name: 'Maven', commands: ['mvn --version'], required: true },
  ],
  'Java (Gradle)': [
    { name: 'Java JDK', commands: ['java --version', 'java -version'], required: true },
    { name: 'Gradle', commands: ['gradle --version'], required: true },
  ],
  Docker: [
    {
      name: 'Docker',
      commands: ['docker --version'],
      required: false,
      installHint: 'https://docs.docker.com/get-docker/',
    },
  ],
  'Docker Compose': [
    {
      name: 'Docker Compose',
      commands: ['docker compose version', 'docker-compose --version'],
      required: false,
    },
  ],
};

// Always check these regardless of language
const UNIVERSAL_TOOLS = [
  { name: 'Git', commands: ['git --version'], required: true },
  {
    name: 'Docker',
    commands: ['docker --version'],
    required: false,
    installHint: 'https://docs.docker.com/get-docker/',
  },
  {
    name: 'Codex CLI',
    commands: ['codex --version'],
    required: true,
    installHint: 'npm install -g @openai/codex',
  },
  {
    name: 'Repobase',
    commands: ['repobase --version'],
    required: false,
    installHint: 'npm install -g repobase',
  },
];

async function detectEnvironment(repoPath: string): Promise<EnvironmentCheck[]> {
  // Detect frameworks from repo to know what tools to check
  let frameworks: string[] = [];
  try {
    const analysis = await analyseRepo(repoPath);
    frameworks = analysis.frameworks;
  } catch {
    // If analysis fails, just check universal tools
  }

  const checksToRun = new Map<
    string,
    { name: string; commands: string[]; required: boolean; installHint?: string }
  >();

  // Add universal tools
  for (const tool of UNIVERSAL_TOOLS) {
    checksToRun.set(tool.name, tool);
  }

  // Add framework-specific tools
  for (const framework of frameworks) {
    const tools = TOOL_CHECKS[framework];
    if (tools) {
      for (const tool of tools) {
        if (!checksToRun.has(tool.name)) {
          checksToRun.set(tool.name, tool);
        }
      }
    }
  }

  const results: EnvironmentCheck[] = [];

  for (const tool of checksToRun.values()) {
    const check = await checkTool(tool);
    results.push(check);
  }

  // Sort: required first, then by name
  results.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

async function checkTool(tool: {
  name: string;
  commands: string[];
  required: boolean;
  installHint?: string;
}): Promise<EnvironmentCheck> {
  for (const cmd of tool.commands) {
    try {
      const parts = cmd.split(' ');
      const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
        timeout: 10000,
      });
      const output = (stdout || stderr).trim();
      // Extract version number from output
      const versionMatch = output.match(/(\d+\.\d+[\.\d]*)/);
      return {
        name: tool.name,
        required: tool.required,
        installed: true,
        version: versionMatch?.[1],
        installCommand: tool.installHint,
      };
    } catch {
      // Command failed, try next alternative
      continue;
    }
  }

  return {
    name: tool.name,
    required: tool.required,
    installed: false,
    installCommand: tool.installHint,
  };
}

// --- Suggested actions ---

function computeSuggestedActions(
  artifacts: ArtifactDetection,
  envChecks: EnvironmentCheck[],
): OnboardAction[] {
  const actions: OnboardAction[] = [];

  if (!artifacts.agentsMdExists) {
    actions.push('generate-agents-md');
  } else if (artifacts.agentsMdStaleness === 'stale') {
    actions.push('update-agents-md');
  }

  if (!artifacts.devcontainerExists) {
    actions.push('generate-devcontainer');
  }

  if (!artifacts.readmeExists) {
    actions.push('generate-readme');
  }

  const hasMissingRequired = envChecks.some((c) => c.required && !c.installed);
  if (hasMissingRequired) {
    actions.push('install-dependencies');
  }

  return actions;
}

/**
 * Write an artifact file to the repo directory.
 */
export function readArtifact(repoPath: string, artifactType: string): string | null {
  let targetPath: string;
  switch (artifactType) {
    case 'agents-md':
      targetPath = path.join(repoPath, 'AGENTS.md');
      break;
    case 'devcontainer':
      targetPath = path.join(repoPath, '.devcontainer', 'devcontainer.json');
      break;
    case 'readme':
      targetPath = path.join(repoPath, 'README.md');
      break;
    default:
      return null;
  }
  try {
    return fs.readFileSync(targetPath, 'utf-8');
  } catch {
    return null;
  }
}

export function writeArtifact(
  repoPath: string,
  artifactType: string,
  content: string,
): { path: string } {
  let targetPath: string;

  switch (artifactType) {
    case 'agents-md':
      targetPath = path.join(repoPath, 'AGENTS.md');
      break;
    case 'devcontainer':
      targetPath = path.join(repoPath, '.devcontainer', 'devcontainer.json');
      // Ensure .devcontainer directory exists
      fs.mkdirSync(path.join(repoPath, '.devcontainer'), { recursive: true });
      break;
    case 'env-template':
      targetPath = path.join(repoPath, '.env.template');
      break;
    case 'readme':
      targetPath = path.join(repoPath, 'README.md');
      break;
    case 'copilot-instructions':
      targetPath = path.join(repoPath, '.github', 'copilot-instructions.md');
      fs.mkdirSync(path.join(repoPath, '.github'), { recursive: true });
      break;
    default:
      throw new Error(`Unknown artifact type: ${artifactType}`);
  }

  fs.writeFileSync(targetPath, content, 'utf-8');
  return { path: targetPath };
}
