export type RunCommandSource =
  | 'package.json'
  | 'Makefile'
  | 'Cargo.toml'
  | 'pyproject.toml'
  | 'go.mod'
  | 'docker-compose.yml'
  | 'ai'
  | 'custom';

export interface RunCommand {
  id: string;
  repoId: string;
  label: string;
  command: string;
  source: RunCommandSource;
  lastUsedAt?: string;
  pinned: boolean;
}

export interface RunStatus {
  repoId: string;
  command: string;
  running: boolean;
  exitCode?: number;
  signal?: string;
  startedAt: string;
}
