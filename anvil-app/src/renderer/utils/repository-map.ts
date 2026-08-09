import type {
  ModuleSummary,
  RepositoryChangedFile,
  RepositoryChangeStatus,
} from '../../shared/types';

export interface RepositoryModuleChanges {
  modulePath: string;
  files: RepositoryChangedFile[];
  counts: Record<RepositoryChangeStatus, number>;
}

const EMPTY_COUNTS: Record<RepositoryChangeStatus, number> = {
  added: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
};

export function groupChangesByModule(
  modules: ModuleSummary[],
  files: RepositoryChangedFile[],
): RepositoryModuleChanges[] {
  const groups = new Map<string, RepositoryChangedFile[]>();

  for (const file of files) {
    const modulePath = findModuleForFile(modules, file.filePath) ?? 'Other repository files';
    const group = groups.get(modulePath) ?? [];
    group.push(file);
    groups.set(modulePath, group);
  }

  return [...groups.entries()]
    .map(([modulePath, groupedFiles]) => ({
      modulePath,
      files: groupedFiles.toSorted((a, b) => a.filePath.localeCompare(b.filePath)),
      counts: groupedFiles.reduce<Record<RepositoryChangeStatus, number>>(
        (counts, file) => ({ ...counts, [file.status]: counts[file.status] + 1 }),
        { ...EMPTY_COUNTS },
      ),
    }))
    .toSorted(
      (a, b) => b.files.length - a.files.length || a.modulePath.localeCompare(b.modulePath),
    );
}

export function findModuleForFile(modules: ModuleSummary[], filePath: string): string | undefined {
  const normalizedFilePath = normalizePath(filePath);
  const matchingModule = modules
    .filter((module) => module.path !== '.')
    .map((module) => ({ module, path: normalizePath(module.path) }))
    .filter(({ path }) => normalizedFilePath === path || normalizedFilePath.startsWith(`${path}/`))
    .toSorted((a, b) => b.path.length - a.path.length)[0];

  if (matchingModule) return matchingModule.module.path;
  return modules.find((module) => module.path === '.')?.path;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
}
