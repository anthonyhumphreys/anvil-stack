import path from 'node:path';
import fs from 'node:fs';
import type { LanguageBreakdown } from '../../shared/types.js';
import { type FileEntry, walkRepo, buildDirectoryTree } from '../utils/file-walker.js';

// Extension → language mapping
const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.cs': 'C#',
  '.py': 'Python',
  '.java': 'Java',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.cc': 'C++',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'Less',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.xml': 'XML',
  '.md': 'Markdown',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.ps1': 'PowerShell',
  '.dockerfile': 'Dockerfile',
};

// Framework detection from config files
const FRAMEWORK_INDICATORS: Record<string, string> = {
  'package.json': 'Node.js',
  'tsconfig.json': 'TypeScript',
  'next.config.js': 'Next.js',
  'next.config.ts': 'Next.js',
  'next.config.mjs': 'Next.js',
  'nuxt.config.ts': 'Nuxt',
  'nuxt.config.js': 'Nuxt',
  'angular.json': 'Angular',
  'vite.config.ts': 'Vite',
  'vite.config.js': 'Vite',
  'webpack.config.js': 'Webpack',
  'tailwind.config.js': 'Tailwind CSS',
  'tailwind.config.ts': 'Tailwind CSS',
  'requirements.txt': 'Python',
  'pyproject.toml': 'Python',
  'setup.py': 'Python',
  Pipfile: 'Python (Pipenv)',
  'Cargo.toml': 'Rust',
  'go.mod': 'Go',
  'pom.xml': 'Java (Maven)',
  'build.gradle': 'Java (Gradle)',
  'build.gradle.kts': 'Kotlin (Gradle)',
  Gemfile: 'Ruby',
  'composer.json': 'PHP',
  Dockerfile: 'Docker',
  'docker-compose.yml': 'Docker Compose',
  'docker-compose.yaml': 'Docker Compose',
};

// Key file prioritisation patterns
const KEY_FILE_PATTERNS = [
  /^index\.\w+$/,
  /^main\.\w+$/,
  /^app\.\w+$/,
  /^server\.\w+$/,
  /^program\.\w+$/i,
  /^startup\.\w+$/i,
  /readme\.md$/i,
  /^config\./i,
  /\.config\.\w+$/,
];

export interface IndexResult {
  files: FileEntry[];
  languages: LanguageBreakdown[];
  frameworks: string[];
  modules: ModuleInfo[];
  configFiles: string[];
  fileTree: string;
}

export interface ModuleInfo {
  path: string;
  files: FileEntry[];
  keyFiles: string[];
  directoryTree: string;
}

export async function analyseRepo(repoPath: string): Promise<IndexResult> {
  const files = await walkRepo(repoPath);
  const languages = detectLanguages(files);
  const frameworks = detectFrameworks(repoPath, files);
  const modules = identifyModules(repoPath, files);
  const configFiles = findConfigFiles(files);
  const fileTree = buildDirectoryTree(files);

  return { files, languages, frameworks, modules, configFiles, fileTree };
}

function detectLanguages(files: FileEntry[]): LanguageBreakdown[] {
  const counts: Record<string, { count: number; bytes: number }> = {};
  let totalBytes = 0;

  for (const file of files) {
    const lang = EXTENSION_MAP[file.extension];
    if (!lang) continue;
    if (!counts[lang]) counts[lang] = { count: 0, bytes: 0 };
    counts[lang].count++;
    counts[lang].bytes += file.sizeBytes;
    totalBytes += file.sizeBytes;
  }

  if (totalBytes === 0) return [];

  return Object.entries(counts)
    .map(([language, { count, bytes }]) => ({
      language,
      percentage: Math.round((bytes / totalBytes) * 100),
      fileCount: count,
    }))
    .sort((a, b) => b.percentage - a.percentage);
}

function detectFrameworks(repoPath: string, files: FileEntry[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const basename = path.basename(file.relativePath);
    const framework = FRAMEWORK_INDICATORS[basename];
    if (framework) found.add(framework);
  }

  // Check package.json for React/Vue/Svelte
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['react']) found.add('React');
      if (allDeps['vue']) found.add('Vue');
      if (allDeps['svelte']) found.add('Svelte');
      if (allDeps['express']) found.add('Express');
      if (allDeps['fastify']) found.add('Fastify');
      if (allDeps['@nestjs/core']) found.add('NestJS');
      if (allDeps['electron']) found.add('Electron');
    } catch {
      /* ignore parse errors */
    }
  }

  // Check .csproj/.sln for .NET
  const hasCsproj = files.some((f) => f.extension === '.csproj' || f.extension === '.sln');
  if (hasCsproj) found.add('.NET');

  return [...found];
}

const MAX_MODULES = 25;
// If a single group holds more than this share of all files, descend one level
// inside it so monorepo layouts (e.g. src/ holding 95% of files) still split.
const DOMINANT_GROUP_THRESHOLD = 0.6;

function identifyModules(repoPath: string, files: FileEntry[]): ModuleInfo[] {
  const workspaceDirs = detectWorkspaceMemberDirs(repoPath, files);
  const groups = new Map<string, FileEntry[]>();

  const push = (key: string, file: FileEntry) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(file);
  };

  for (const file of files) {
    // Workspace manifests win: a file under a declared member dir belongs to
    // that member even when it is nested deeper than the top level.
    const member = workspaceDirs
      .filter((dir) => file.relativePath === dir || file.relativePath.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (member) {
      push(member, file);
      continue;
    }
    const parts = file.relativePath.split('/');
    push(parts.length > 1 ? parts[0] : '.', file);
  }

  // Descend one level into any group that dominates the repo so a single
  // giant module (e.g. src/ in a monorepo) splits into its children.
  const total = files.length;
  for (const [groupPath, groupFiles] of [...groups.entries()]) {
    if (groupPath === '.' || groupFiles.length <= total * DOMINANT_GROUP_THRESHOLD) continue;
    let descended = false;
    for (const file of groupFiles) {
      const rest = file.relativePath.slice(groupPath.length + 1);
      const nextSegment = rest.split('/')[0];
      if (rest.includes('/') && nextSegment) {
        push(`${groupPath}/${nextSegment}`, file);
        descended = true;
      }
    }
    if (descended) {
      groups.set(
        groupPath,
        groupFiles.filter((file) => !file.relativePath.slice(groupPath.length + 1).includes('/')),
      );
      if (groups.get(groupPath)!.length === 0) groups.delete(groupPath);
    }
  }

  const modules: ModuleInfo[] = [];
  const sortedDirs = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_MODULES);

  for (const [dir, dirFiles] of sortedDirs) {
    const keyFiles = selectKeyFiles(dirFiles);
    const directoryTree = buildDirectoryTree(dirFiles);

    modules.push({
      path: dir,
      files: dirFiles,
      keyFiles: keyFiles.map((f) => f.relativePath),
      directoryTree,
    });
  }

  return modules;
}

/**
 * Detect monorepo workspace member directories from common manifests:
 * pnpm-workspace.yaml, package.json#workspaces, go.work, Cargo.toml [workspace].
 * Returns concrete directory prefixes (e.g. 'packages/foo') that contain files.
 */
function detectWorkspaceMemberDirs(repoPath: string, files: FileEntry[]): string[] {
  const patterns: string[] = [];

  // pnpm-workspace.yaml — `packages:` list entries
  const pnpmWorkspace = readManifestFile(repoPath, 'pnpm-workspace.yaml');
  if (pnpmWorkspace) {
    const packagesMatch = pnpmWorkspace.match(/^packages:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (packagesMatch) {
      for (const line of packagesMatch[1].split('\n')) {
        const entry = line.match(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/);
        if (entry && !entry[1].startsWith('!')) patterns.push(entry[1]);
      }
    }
  }

  // package.json#workspaces — array or { packages: [...] }
  const pkgJson = readManifestFile(repoPath, 'package.json');
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { workspaces?: string[] | { packages?: string[] } };
      const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(workspaces)) {
        patterns.push(...workspaces.filter((w) => typeof w === 'string' && !w.startsWith('!')));
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // go.work — `use` directives (single-line and block form)
  const goWork = readManifestFile(repoPath, 'go.work');
  if (goWork) {
    const block = goWork.match(/use\s*\(([^)]*)\)/);
    const useLines = block
      ? block[1].split('\n')
      : goWork.split('\n').filter((line) => /^\s*use\s+/.test(line));
    for (const line of useLines) {
      const entry = line.match(/^\s*use\s+['"]?([^'")\s]+)['"]?\s*$/) ?? line.match(/([.\w/-]+)/);
      if (entry) patterns.push(entry[1].replace(/^\.\//, ''));
    }
  }

  // Cargo.toml — [workspace] members array
  const cargoToml = readManifestFile(repoPath, 'Cargo.toml');
  if (cargoToml) {
    const workspaceSection = cargoToml.match(/\[workspace\]([\s\S]*?)(?=\n\[|$)/);
    const members = workspaceSection?.[1].match(/members\s*=\s*\[([\s\S]*?)\]/);
    if (members) {
      for (const entry of members[1].matchAll(/['"]([^'"]+)['"]/g)) {
        if (!entry[1].startsWith('!')) patterns.push(entry[1]);
      }
    }
  }

  const dirs = new Set<string>();
  const knownDirs = new Set(
    files.flatMap((file) => {
      const parts = file.relativePath.split('/');
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    }),
  );

  for (const pattern of patterns) {
    const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) continue;

    if (!normalized.includes('*')) {
      // Literal member path
      if (knownDirs.has(normalized)) dirs.add(normalized);
      continue;
    }

    // Glob member — resolve the static base and enumerate its child dirs.
    const base = normalized.split('*')[0].replace(/\/+$/, '');
    if (!base || !knownDirs.has(base)) continue;
    for (const dir of knownDirs) {
      if (dir.startsWith(`${base}/`) && dir.split('/').length === base.split('/').length + 1) {
        dirs.add(dir);
      }
    }
  }

  return [...dirs];
}

function readManifestFile(repoPath: string, name: string): string | null {
  try {
    const fullPath = path.join(repoPath, name);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
  } catch {
    return null;
  }
}

function selectKeyFiles(files: FileEntry[]): FileEntry[] {
  const scored = files.map((file) => {
    let score = 0;
    const basename = path.basename(file.relativePath);

    // Prioritise key file patterns
    for (const pattern of KEY_FILE_PATTERNS) {
      if (pattern.test(basename)) {
        score += 10;
        break;
      }
    }

    // Prioritise config files
    if (FRAMEWORK_INDICATORS[basename]) score += 8;

    // Prefer larger code files (more likely to be substantial)
    if (file.sizeBytes > 1000) score += 2;
    if (file.sizeBytes > 5000) score += 2;

    // Prefer source code over markup/config
    const lang = EXTENSION_MAP[file.extension];
    if (lang && !['JSON', 'YAML', 'XML', 'Markdown'].includes(lang)) score += 3;

    return { file, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.file);
}

function findConfigFiles(files: FileEntry[]): string[] {
  return files
    .filter((f) => {
      const basename = path.basename(f.relativePath);
      return (
        FRAMEWORK_INDICATORS[basename] ||
        basename.endsWith('.config.ts') ||
        basename.endsWith('.config.js')
      );
    })
    .map((f) => f.relativePath);
}
