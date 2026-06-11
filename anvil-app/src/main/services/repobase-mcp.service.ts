import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getRepobaseSupport } from './repobase.service.js';

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface ToolCallTextContent {
  type: string;
  text?: string;
}

export interface RepobaseDeepContext {
  repoId: string;
  rootListing: unknown[];
  configMatches: unknown[];
  semanticSearches: Array<{ query: string; results: unknown[] }>;
  fileReads: Array<{ path: string; content: string }>;
}

export class RepobaseMcpClient {
  private process: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private initialized = false;

  constructor(private readonly mcpEntry: string) {}

  async start(): Promise<void> {
    if (this.process && this.initialized) return;

    this.process = spawn(process.execPath, [this.mcpEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleMessage(trimmed);
      }
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn('[Repobase MCP] stderr:', text);
    });

    this.process.on('error', (err) => {
      this.rejectAll(new Error(`Repobase MCP process error: ${err.message}`));
    });

    this.process.on('exit', (code, signal) => {
      if (!this.initialized) {
        this.rejectAll(
          new Error(`Repobase MCP exited before initialization (code=${code} signal=${signal})`),
        );
      }
    });

    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'anvil', version: '0.1.0' },
    });

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.process) return;
    try {
      this.process.stdin?.end();
    } catch {
      // ignore
    }
    this.process.kill();
    this.process = null;
    this.initialized = false;
    this.pending.clear();
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    const content = Array.isArray(result.content) ? (result.content as ToolCallTextContent[]) : [];
    const text = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();

    if (!text) {
      return [] as T;
    }

    return JSON.parse(text) as T;
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.process?.stdin?.writable) {
      throw new Error('Repobase MCP process is not writable');
    }

    const id = randomUUID();
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Repobase MCP request timed out: ${method}`));
        }
      }, 30_000);
    });

    this.process.stdin.write(payload + '\n');
    return response;
  }

  private handleMessage(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const id = typeof message.id === 'string' ? message.id : null;
    if (!id) return;

    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (message.error) {
      const error = message.error as { message?: string };
      pending.reject(new Error(error.message ?? 'Unknown Repobase MCP error'));
      return;
    }

    pending.resolve((message.result ?? {}) as Record<string, unknown>);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function collectRepobaseDeepContext(
  remoteUrl: string,
  keyFiles: string[],
  onProgress?: (message: string) => void,
): Promise<RepobaseDeepContext> {
  const support = await getRepobaseSupport(remoteUrl);
  if (!support.available || !support.mcpEntry || !support.repoId) {
    throw new Error(support.warnings[0] ?? 'Repobase deep indexing is unavailable.');
  }

  const client = new RepobaseMcpClient(support.mcpEntry);
  await client.start();

  try {
    onProgress?.('Verifying Repobase repository metadata...');
    const repos = await client.callTool<Array<{ id: string; url: string }>>('list_repos', {});
    const repoExists = repos.some((repo) => repo.id === support.repoId || repo.url === remoteUrl);
    if (!repoExists) {
      throw new Error('Repobase does not yet contain this repository.');
    }

    onProgress?.('Reading indexed repository structure...');
    const rootListing = await client.callTool<unknown[]>('list_files', { repo: support.repoId });
    const configMatches = await client.callTool<unknown[]>('glob_files', {
      repo: support.repoId,
      pattern:
        '**/*{package,tsconfig,vite,webpack,next,nuxt,tailwind,docker-compose,pyproject,Cargo,go,build}.**',
      limit: 40,
    });

    const queries = [
      'application bootstrap entry point server startup main',
      'router route controller endpoint api handler',
      'database schema migration model repository persistence',
      'authentication login token session oauth',
      'worker queue job background cron event',
    ];

    const semanticSearches: Array<{ query: string; results: unknown[] }> = [];
    for (const query of queries) {
      onProgress?.(`Searching indexed code: ${query}`);
      const results = await client.callTool<unknown[]>('search', {
        repo: support.repoId,
        query,
        mode: 'hybrid',
        limit: 6,
      });
      semanticSearches.push({ query, results });
    }

    const pathsToRead = [...new Set(keyFiles)].slice(0, 12);
    const fileReads: Array<{ path: string; content: string }> = [];
    for (const filePath of pathsToRead) {
      onProgress?.(`Reading indexed file: ${filePath}`);
      try {
        const file = await client.callTool<{ content: string; path: string }>('read_file', {
          repo: support.repoId,
          path: filePath,
          offset: 1,
          limit: 180,
          lineNumbers: true,
        });
        fileReads.push({ path: file.path ?? filePath, content: file.content ?? '' });
      } catch {
        // Some local files may not be present in the Repobase clone; skip them.
      }
    }

    return {
      repoId: support.repoId,
      rootListing,
      configMatches,
      semanticSearches,
      fileReads,
    };
  } finally {
    await client.close();
  }
}
