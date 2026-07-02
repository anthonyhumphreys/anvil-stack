import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface CodexAgentsFile {
  path: string;
  content: string;
  exists: boolean;
  updatedAt?: string;
}

export interface CodexAgentsSaveResult {
  path: string;
  savedAt: string;
  bytes: number;
}

const CODEX_AGENTS_PATH = join(homedir(), '.codex', 'AGENTS.md');

export async function readCodexAgentsFile(): Promise<CodexAgentsFile> {
  try {
    const [content, fileStat] = await Promise.all([
      readFile(CODEX_AGENTS_PATH, 'utf-8'),
      stat(CODEX_AGENTS_PATH),
    ]);
    return {
      path: CODEX_AGENTS_PATH,
      content,
      exists: true,
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    return {
      path: CODEX_AGENTS_PATH,
      content: '',
      exists: false,
    };
  }
}

export async function writeCodexAgentsFile(content: string): Promise<CodexAgentsSaveResult> {
  await mkdir(dirname(CODEX_AGENTS_PATH), { recursive: true });
  await writeFile(CODEX_AGENTS_PATH, content, 'utf-8');
  return {
    path: CODEX_AGENTS_PATH,
    savedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}
