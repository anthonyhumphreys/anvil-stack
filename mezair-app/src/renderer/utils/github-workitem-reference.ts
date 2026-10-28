import type { WorkItemConnection } from '../../shared/types';

/** Canonicalize a pasted GitHub issue URL only when it identifies this connection's repo. */
export function normalizeGitHubIssueUrl(
  value: string,
  connection: Pick<WorkItemConnection, 'githubHost' | 'githubOwner' | 'githubRepo'>,
): string | undefined {
  const { githubHost, githubOwner, githubRepo } = connection;
  if (!githubOwner?.trim() || !githubRepo?.trim()) return undefined;

  let input: URL;
  let configuredHost: URL;
  try {
    input = new URL(value.trim());
    configuredHost = new URL(githubHost?.trim() || 'https://github.com');
  } catch {
    return undefined;
  }

  if (
    input.protocol !== 'https:' ||
    input.username ||
    input.password ||
    input.search ||
    input.hash ||
    input.origin.toLowerCase() !== configuredHost.origin.toLowerCase()
  ) {
    return undefined;
  }

  const segments = input.pathname.split('/').filter(Boolean);
  const issueNumber = segments[3]?.replace(/^0+(?=\d)/, '');
  if (
    segments.length !== 4 ||
    segments[2] !== 'issues' ||
    !/^\d+$/.test(segments[3]) ||
    issueNumber === '0' ||
    segments[0].toLowerCase() !== githubOwner.trim().toLowerCase() ||
    segments[1].toLowerCase() !== githubRepo.trim().toLowerCase()
  ) {
    return undefined;
  }

  return `${configuredHost.origin.toLowerCase()}/${githubOwner.trim().toLowerCase()}/${githubRepo.trim().toLowerCase()}/issues/${issueNumber}`;
}
