import simpleGit from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RemoteRepo } from '../../shared/types.js';
import { getSettings } from './settings.service.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// gh CLI helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the `gh` CLI is installed and the user is authenticated.
 * Returns { authenticated, username } or { authenticated: false, error }.
 */
export async function checkGhAuthStatus(): Promise<{
  authenticated: boolean;
  username?: string;
  error?: string;
}> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'status', '--active'], {
      timeout: 10_000,
    });
    // gh auth status prints "Logged in to github.com account <username>"
    const match = stdout.match(/account\s+(\S+)/i);
    return { authenticated: true, username: match?.[1] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return {
        authenticated: false,
        error: 'gh CLI not found. Install it from https://cli.github.com',
      };
    }
    return { authenticated: false, error: 'Not logged in. Run `gh auth login` in your terminal.' };
  }
}

// ---------------------------------------------------------------------------
// GitHub (via gh CLI)
// ---------------------------------------------------------------------------

export async function listGithubRepos(): Promise<RemoteRepo[]> {
  const auth = await checkGhAuthStatus();
  if (!auth.authenticated) {
    throw new Error(auth.error ?? 'GitHub CLI not authenticated');
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'repo',
        'list',
        '--limit',
        '500',
        '--json',
        'name,url,description,visibility,defaultBranchRef,updatedAt',
      ],
      { timeout: 30_000 },
    );

    const data = JSON.parse(stdout) as Array<{
      name: string;
      url: string;
      description: string;
      visibility: string;
      defaultBranchRef: { name: string } | null;
      updatedAt: string;
    }>;

    return data.map((repo) => ({
      name: repo.name,
      cloneUrl: repo.url,
      provider: 'github' as const,
      description: repo.description || undefined,
      visibility: repo.visibility.toLowerCase() as 'public' | 'private',
      defaultBranch: repo.defaultBranchRef?.name,
      updatedAt: repo.updatedAt,
    }));
  } catch (err) {
    throw new Error(
      `Failed to list GitHub repos: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

export async function listAdoRepos(): Promise<RemoteRepo[]> {
  const settings = getSettings();
  if (!settings.adoPat || !settings.adoOrganizationUrl || !settings.adoProject) {
    throw new Error('Azure DevOps credentials not configured');
  }

  const base = settings.adoOrganizationUrl.replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(settings.adoProject)}/_apis/git/repositories?api-version=7.1`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 203) throw new Error('Invalid ADO PAT');
    throw new Error(`ADO API returned HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    value: Array<{
      name: string;
      remoteUrl: string;
      defaultBranch?: string;
      size: number;
    }>;
  };

  return data.value.map((repo) => ({
    name: repo.name,
    cloneUrl: repo.remoteUrl,
    provider: 'ado' as const,
    defaultBranch: repo.defaultBranch?.replace('refs/heads/', ''),
    updatedAt: undefined,
  }));
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export async function cloneRepo(
  cloneUrl: string,
  targetDir: string,
  provider: 'github' | 'ado',
  onProgress?: (message: string) => void,
): Promise<string> {
  // Derive repo name from URL for the target folder
  const repoName = path.basename(cloneUrl, '.git');
  const localPath = path.join(targetDir, repoName);

  if (fs.existsSync(localPath)) {
    throw new Error(`Directory already exists: ${localPath}`);
  }

  onProgress?.('Cloning...');

  if (provider === 'github') {
    // Use gh CLI — it handles auth automatically
    const auth = await checkGhAuthStatus();
    if (!auth.authenticated) {
      throw new Error(auth.error ?? 'GitHub CLI not authenticated');
    }
    await execFileAsync('gh', ['repo', 'clone', cloneUrl, localPath], {
      timeout: 300_000, // 5 min for large repos
    });
  } else {
    const settings = getSettings();
    if (!settings.adoPat) {
      throw new Error('ADO PAT not configured');
    }
    // ADO uses PAT injected into URL
    const parsed = new URL(cloneUrl);
    parsed.username = '';
    parsed.password = settings.adoPat;

    const git = simpleGit();
    await git.clone(parsed.toString(), localPath, ['--progress']);
  }

  onProgress?.('Done');
  return localPath;
}
