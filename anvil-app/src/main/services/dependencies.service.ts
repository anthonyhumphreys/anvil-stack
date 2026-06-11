import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  DependencyAuditResult,
  DependencyRecord,
  LicenseAuditResult,
  PackageManager,
  SbomFormat,
} from '../../shared/types.js';
import { APP_NAME } from '../../shared/app-identity.js';

const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'nuget', 'python'];
const SBOM_FORMATS: SbomFormat[] = ['cyclonedx-json', 'spdx-json', 'csv'];
const JS_LOCK_MANAGER: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

function runCommand(
  cwd: string,
  cmd: string,
  args: string[],
  successExitCodes: number[] = [0],
): Promise<DependencyAuditResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to run ${cmd}: ${err.message}`));
    });
    proc.on('close', (code) => {
      const result = {
        manager: commandToManager(cmd, args),
        command: [cmd, ...args].join(' '),
        exitCode: code,
        stdout,
        stderr,
        ok: code !== null && successExitCodes.includes(code),
      };
      if (result.ok) {
        resolve(result);
        return;
      }
      reject(new Error(stderr || stdout || `Command failed: ${result.command}`));
    });
  });
}

export function isPackageManager(value: unknown): value is PackageManager {
  return typeof value === 'string' && PACKAGE_MANAGERS.includes(value as PackageManager);
}

export function isSbomFormat(value: unknown): value is SbomFormat {
  return typeof value === 'string' && SBOM_FORMATS.includes(value as SbomFormat);
}

export async function listDependencies(repoPath: string): Promise<DependencyRecord[]> {
  return [
    ...listJavaScriptDependencies(repoPath),
    ...listNugetDependencies(repoPath),
    ...listPythonDependencies(repoPath),
  ].sort((a, b) => `${a.manager}:${a.name}`.localeCompare(`${b.manager}:${b.name}`));
}

export async function runDependencyAudit(
  repoPath: string,
  manager: PackageManager,
): Promise<DependencyAuditResult> {
  assertPackageManager(manager);

  if (manager === 'npm') {
    return runCommand(repoPath, 'npm', ['audit', '--json'], [0, 1]);
  }
  if (manager === 'pnpm') {
    return runCommand(repoPath, 'pnpm', ['audit', '--json'], [0, 1]);
  }
  if (manager === 'yarn') {
    return runCommand(repoPath, 'yarn', ['npm', 'audit', '--json'], [0, 1]);
  }
  if (manager === 'nuget') {
    return runCommand(repoPath, 'dotnet', ['list', 'package', '--vulnerable'], [0, 1]);
  }
  if (manager === 'python') {
    return runCommand(repoPath, 'pip', ['list', '--outdated'], [0]);
  }

  throw new Error(`Unsupported dependency manager: ${manager}`);
}

export async function auditLicenses(repoPath: string): Promise<LicenseAuditResult> {
  const packages = (await listDependencies(repoPath)).map((dependency) => ({
    ...dependency,
    license: dependency.license ?? 'UNKNOWN',
  }));
  return {
    generatedAt: new Date().toISOString(),
    total: packages.length,
    unknown: packages.filter((dependency) => dependency.license === 'UNKNOWN').length,
    packages,
  };
}

export async function exportSbom(repoPath: string, format: SbomFormat): Promise<string> {
  const dependencies = await listDependencies(repoPath);
  if (format === 'cyclonedx-json')
    return JSON.stringify(toCycloneDx(repoPath, dependencies), null, 2);
  if (format === 'spdx-json') return JSON.stringify(toSpdx(repoPath, dependencies), null, 2);
  if (format === 'csv') return toCsv(dependencies);
  throw new Error(`Unsupported SBOM format: ${format}`);
}

function listJavaScriptDependencies(repoPath: string): DependencyRecord[] {
  const packageJsonPath = join(repoPath, 'package.json');
  if (!existsSync(packageJsonPath)) return [];

  const pkg = readJsonFile<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>(packageJsonPath);
  if (!pkg) return [];

  const manager = detectJavaScriptManager(repoPath);
  const map = new Map<string, string>([
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
    ...Object.entries(pkg.optionalDependencies ?? {}),
  ]);

  return [...map.entries()].map(([name, version]) =>
    enrichDependency(repoPath, name, version, manager),
  );
}

function listNugetDependencies(repoPath: string): DependencyRecord[] {
  return readdirSafe(repoPath)
    .filter((file) => file.endsWith('.csproj'))
    .flatMap((file) => {
      const content = readFileSync(join(repoPath, file), 'utf8');
      return [...content.matchAll(/<PackageReference\s+[^>]*Include=["']([^"']+)["'][^>]*>/g)].map(
        (match) => {
          const element = match[0];
          const version =
            element.match(/\sVersion=["']([^"']+)["']/)?.[1] ??
            content.match(
              new RegExp(
                `<PackageReference\\s+[^>]*Include=["']${escapeRegex(match[1])}["'][^>]*>[\\s\\S]*?<Version>([^<]+)</Version>`,
              ),
            )?.[1] ??
            'unknown';
          return {
            name: match[1],
            version,
            manager: 'nuget' as const,
            license: 'UNKNOWN',
          };
        },
      );
    });
}

function listPythonDependencies(repoPath: string): DependencyRecord[] {
  const requirementsPath = join(repoPath, 'requirements.txt');
  const dependencies: DependencyRecord[] = [];
  if (existsSync(requirementsPath)) {
    for (const line of readFileSync(requirementsPath, 'utf8').split(/\r?\n/)) {
      const cleaned = line.replace(/#.*/, '').trim();
      if (!cleaned || cleaned.startsWith('-')) continue;
      const match = cleaned.match(/^([A-Za-z0-9_.-]+)\s*(?:==|>=|<=|~=|>|<)?\s*([^;]+)?/);
      if (!match) continue;
      dependencies.push({
        name: match[1],
        version: match[2]?.trim() || 'unknown',
        manager: 'python',
        license: 'UNKNOWN',
      });
    }
  }
  return dependencies;
}

function enrichDependency(
  repoPath: string,
  name: string,
  version: string,
  manager: PackageManager,
): DependencyRecord {
  const license = readPackageLicense(repoPath, name);
  return {
    name,
    version,
    manager,
    deprecated: isDeprecated(name, version),
    license,
    alternative: alternativeFor(name),
  };
}

function readPackageLicense(repoPath: string, name: string): string | undefined {
  const packageJsonPath = join(repoPath, 'node_modules', ...name.split('/'), 'package.json');
  const pkg = existsSync(packageJsonPath)
    ? readJsonFile<{ license?: string }>(packageJsonPath)
    : null;
  return pkg?.license;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (err) {
    console.warn(`[Dependencies] Failed to parse ${filePath}:`, err);
    return null;
  }
}

function detectJavaScriptManager(repoPath: string): PackageManager {
  return JS_LOCK_MANAGER.find(([lockfile]) => existsSync(join(repoPath, lockfile)))?.[1] ?? 'npm';
}

function isDeprecated(name: string, version: string): boolean {
  const normalizedVersion = version.replace(/^[^\d]*/, '');
  return (
    /^(request|left-pad)$/i.test(name) ||
    (name === 'core-js' && normalizedVersion.startsWith('2.')) ||
    (name === 'uuid' && normalizedVersion.startsWith('3.'))
  );
}

function alternativeFor(name: string): string | undefined {
  if (/^request$/i.test(name)) return 'node-fetch or axios';
  if (/^left-pad$/i.test(name)) return 'native String.prototype.padStart';
  if (name === 'core-js') return 'core-js v3';
  if (name === 'uuid') return 'uuid v9+ or crypto.randomUUID';
  return undefined;
}

function toCycloneDx(repoPath: string, dependencies: DependencyRecord[]): unknown {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: basename(repoPath),
      },
    },
    components: dependencies.map((dependency) => ({
      type: 'library',
      name: dependency.name,
      version: dependency.version,
      purl: packageUrl(dependency),
      licenses: [{ license: { id: dependency.license ?? 'UNKNOWN' } }],
    })),
  };
}

function toSpdx(repoPath: string, dependencies: DependencyRecord[]): unknown {
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: basename(repoPath),
    documentNamespace: `https://anvil.local/sbom/${basename(repoPath)}-${Date.now()}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: [`Tool: ${APP_NAME}`],
    },
    packages: dependencies.map((dependency, index) => ({
      name: dependency.name,
      SPDXID: `SPDXRef-Package-${index + 1}`,
      versionInfo: dependency.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: dependency.license ?? 'NOASSERTION',
      licenseDeclared: dependency.license ?? 'NOASSERTION',
    })),
  };
}

function toCsv(dependencies: DependencyRecord[]): string {
  return [
    'manager,name,version,license,deprecated,alternative',
    ...dependencies.map((dependency) =>
      [
        dependency.manager,
        dependency.name,
        dependency.version,
        dependency.license ?? 'UNKNOWN',
        String(Boolean(dependency.deprecated)),
        dependency.alternative ?? '',
      ]
        .map(csvCell)
        .join(','),
    ),
  ].join('\n');
}

function packageUrl(dependency: DependencyRecord): string {
  if (dependency.manager === 'nuget') return `pkg:nuget/${dependency.name}@${dependency.version}`;
  if (dependency.manager === 'python') return `pkg:pypi/${dependency.name}@${dependency.version}`;
  return `pkg:npm/${dependency.name}@${dependency.version}`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function assertPackageManager(manager: PackageManager): void {
  if (!isPackageManager(manager)) {
    throw new Error(`Unsupported dependency manager: ${String(manager)}`);
  }
}

function commandToManager(cmd: string, args: string[]): PackageManager {
  if (cmd === 'dotnet') return 'nuget';
  if (cmd === 'pip') return 'python';
  if (cmd === 'yarn' && args[0] === 'npm') return 'yarn';
  return cmd as PackageManager;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
