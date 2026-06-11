import type { BrowserWindow } from 'electron';
import {
  LEGACY_PROTOCOL,
  PRIMARY_PROTOCOL,
} from '../../shared/app-identity.js';
import type { OpenInAnvilLaunchIntent, OpenInAnvilRepoSpec } from '../../shared/types.js';

const SUPPORTED_PROTOCOL_PREFIXES = [
  `${PRIMARY_PROTOCOL}://open`,
  `${LEGACY_PROTOCOL}://open`,
];

let pendingIntent: OpenInAnvilLaunchIntent | null = null;

function inferRepoProvider(cloneUrl: string): OpenInAnvilRepoSpec['provider'] {
  const parsed = new URL(cloneUrl);
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
    return 'github';
  }

  if (hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')) {
    return 'ado';
  }

  throw new Error(`Unsupported repository provider for URL: ${cloneUrl}`);
}

function inferRepoName(cloneUrl: string): string {
  const pathname = new URL(cloneUrl).pathname;
  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? 'repo';
  return lastSegment.replace(/\.git$/i, '');
}

export function parseOpenInAnvilUrl(rawUrl: string): OpenInAnvilLaunchIntent | null {
  if (!SUPPORTED_PROTOCOL_PREFIXES.some((prefix) => rawUrl.startsWith(prefix))) return null;

  const url = new URL(rawUrl);
  const repos = url.searchParams.getAll('repo').map<OpenInAnvilRepoSpec>((cloneUrl) => ({
    cloneUrl,
    provider: inferRepoProvider(cloneUrl),
    name: inferRepoName(cloneUrl),
  }));

  if (repos.length === 0) {
    throw new Error('Open in Anvil links must include at least one repo parameter.');
  }

  return {
    workspaceName: url.searchParams.get('workspaceName') ?? undefined,
    repos,
    iterationId: url.searchParams.get('iterationId') ?? undefined,
    iterationName: url.searchParams.get('iterationName') ?? undefined,
    docsParentId: url.searchParams.get('docsParentId') ?? undefined,
    docsParentTitle: url.searchParams.get('docsParentTitle') ?? undefined,
    sourceUrl: rawUrl,
    receivedAt: new Date().toISOString(),
  };
}

export const parseOpenInDevHubUrl = parseOpenInAnvilUrl;

export function queueLaunchIntent(intent: OpenInAnvilLaunchIntent): void {
  pendingIntent = intent;
}

export function getPendingLaunchIntent(): OpenInAnvilLaunchIntent | null {
  return pendingIntent;
}

export function clearPendingLaunchIntent(): void {
  pendingIntent = null;
}

export function deliverPendingLaunchIntent(mainWindow: BrowserWindow | null): void {
  if (!mainWindow || !pendingIntent) return;
  mainWindow.webContents.send('launch:intent', pendingIntent);
}

export function extractLaunchUrlFromArgv(argv: string[]): string | null {
  return (
    argv.find((arg) => SUPPORTED_PROTOCOL_PREFIXES.some((prefix) => arg.startsWith(prefix))) ?? null
  );
}
