import path from 'node:path';
import fs from 'node:fs';
import type { LanguageBreakdown } from '../../shared/types.js';
import {
  type FileEntry,
  walkRepo,
  buildDirectoryTree,
} from '../utils/file-walker.js';

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

function identifyModules(repoPath: string, files: FileEntry[]): ModuleInfo[] {
  // Group files by top-level directory (max 15 modules)
  const topDirs = new Map<string, FileEntry[]>();

  for (const file of files) {
    const parts = file.relativePath.split('/');
    const topDir = parts.length > 1 ? parts[0] : '.';
    if (!topDirs.has(topDir)) topDirs.set(topDir, []);
    topDirs.get(topDir)!.push(file);
  }

  const modules: ModuleInfo[] = [];
  const sortedDirs = [...topDirs.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15);

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
