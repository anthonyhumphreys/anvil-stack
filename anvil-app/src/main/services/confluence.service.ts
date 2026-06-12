import type { ConfluencePage, DocPage } from '../../shared/types.js';
import type { DocsProviderService } from './docs-provider.js';
import { getSettings } from './settings.service.js';

function getAuthHeaders(): Record<string, string> {
  const settings = getSettings();
  if (!settings.confluenceBaseUrl || !settings.confluencePat) {
    throw new Error('Confluence base URL and PAT must be configured in settings');
  }
  return {
    Authorization: `Bearer ${settings.confluencePat}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function getBaseUrl(): string {
  return getSettings().confluenceBaseUrl.replace(/\/$/, '');
}

/**
 * List pages in a Confluence space.
 */
export async function listPages(spaceKey: string): Promise<ConfluencePage[]> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  const res = await fetchWithVpnCheck(
    `${baseUrl}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&limit=200&expand=version,history.lastUpdated,metadata.labels,ancestors`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`Confluence list failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results: Array<{
      id: string;
      title: string;
      space: { key: string };
      version: { when: string; by: { displayName: string } };
      metadata?: { labels?: { results: Array<{ name: string }> } };
      ancestors?: Array<{ id: string }>;
      _links: { webui: string };
    }>;
  };

  return data.results.map((page) => ({
    id: page.id,
    title: page.title,
    spaceKey: page.space?.key ?? spaceKey,
    lastUpdated: page.version?.when ?? '',
    lastUpdatedBy: page.version?.by?.displayName ?? '',
    url: `${baseUrl}${page._links?.webui ?? ''}`,
    staleness: 'unknown' as const,
    labels: (page.metadata?.labels?.results ?? []).map((l) => l.name),
    parentId: page.ancestors?.length ? page.ancestors[page.ancestors.length - 1].id : undefined,
    provider: 'confluence' as const,
  }));
}

/**
 * List child pages of a specific Confluence page.
 */
export async function listPageChildren(pageId: string): Promise<ConfluencePage[]> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  const res = await fetchWithVpnCheck(
    `${baseUrl}/rest/api/content/${pageId}/child/page?limit=200&expand=version,history.lastUpdated,metadata.labels,ancestors`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch children: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results: Array<{
      id: string;
      title: string;
      space: { key: string };
      version: { when: string; by: { displayName: string } };
      metadata?: { labels?: { results: Array<{ name: string }> } };
      ancestors?: Array<{ id: string }>;
      _links: { webui: string };
    }>;
  };

  return data.results.map((page) => ({
    id: page.id,
    title: page.title,
    spaceKey: page.space?.key ?? '',
    lastUpdated: page.version?.when ?? '',
    lastUpdatedBy: page.version?.by?.displayName ?? '',
    url: `${baseUrl}${page._links?.webui ?? ''}`,
    staleness: 'unknown' as const,
    labels: (page.metadata?.labels?.results ?? []).map((l) => l.name),
    parentId: page.ancestors?.length ? page.ancestors[page.ancestors.length - 1].id : undefined,
    provider: 'confluence' as const,
  }));
}

/**
 * Get a single page's storage-format content.
 */
export async function getPageContent(pageId: string): Promise<string> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  const res = await fetchWithVpnCheck(
    `${baseUrl}/rest/api/content/${pageId}?expand=body.storage,version`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch page ${pageId}: ${res.status}`);
  }

  const data = (await res.json()) as {
    body: { storage: { value: string } };
  };

  return data.body?.storage?.value ?? '';
}

/**
 * Check if a Confluence page is stale relative to a repo.
 * Compares page's last update date against repo's last commit date.
 */
export async function checkStaleness(
  pageId: string,
  repoLastCommitDate: string,
): Promise<ConfluencePage['staleness']> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  const res = await fetchWithVpnCheck(`${baseUrl}/rest/api/content/${pageId}?expand=version`, {
    headers,
  });

  if (!res.ok) return 'unknown';

  const data = (await res.json()) as {
    version: { when: string };
  };

  const pageDate = new Date(data.version?.when ?? 0);
  const repoDate = new Date(repoLastCommitDate);

  // If repo has been updated more than 7 days after the page, it's stale
  const diffDays = (repoDate.getTime() - pageDate.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > 7 ? 'stale' : 'current';
}

/**
 * Update a Confluence page's content.
 */
export async function updatePage(pageId: string, title: string, newContent: string): Promise<void> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  // Get current version
  const versionRes = await fetchWithVpnCheck(
    `${baseUrl}/rest/api/content/${pageId}?expand=version`,
    { headers },
  );

  if (!versionRes.ok) {
    throw new Error(`Failed to get page version: ${versionRes.status}`);
  }

  const versionData = (await versionRes.json()) as {
    version: { number: number };
  };

  const res = await fetchWithVpnCheck(`${baseUrl}/rest/api/content/${pageId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      version: { number: versionData.version.number + 1 },
      title,
      type: 'page',
      body: {
        storage: {
          value: newContent,
          representation: 'storage',
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to update page: ${res.status} ${res.statusText}`);
  }
}

/**
 * Create a new Confluence page.
 */
export async function createPage(
  spaceKey: string,
  title: string,
  content: string,
): Promise<string> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  const res = await fetchWithVpnCheck(`${baseUrl}/rest/api/content`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'page',
      title,
      space: { key: spaceKey },
      body: {
        storage: {
          value: content,
          representation: 'storage',
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create page: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { id: string; _links: { webui: string } };
  return `${baseUrl}${data._links?.webui ?? ''}`;
}

async function fetchWithVpnCheck(url: string, init: RequestInit): Promise<Response> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('abort') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND')
    ) {
      throw new Error('Cannot reach Confluence — are you connected to the university VPN?');
    }
    throw err;
  }
}

export const confluenceProvider: DocsProviderService = {
  async listPages(spaceKeyOrParent?: string): Promise<DocPage[]> {
    const spaceKey = spaceKeyOrParent || getSettings().confluenceSpaceKey;
    return listPages(spaceKey);
  },

  async listChildren(pageId: string): Promise<DocPage[]> {
    return listPageChildren(pageId);
  },

  async getPageContent(pageId: string): Promise<string> {
    return getPageContent(pageId);
  },

  async checkStaleness(
    pageId: string,
    repoLastCommitDate: string,
  ): Promise<ConfluencePage['staleness']> {
    return checkStaleness(pageId, repoLastCommitDate);
  },

  async createPage(spaceKeyOrParent: string, title: string, content: string): Promise<string> {
    return createPage(spaceKeyOrParent, title, content);
  },

  async updatePage(pageId: string, title: string, content: string): Promise<void> {
    return updatePage(pageId, title, content);
  },

  isConfigured(): boolean {
    const settings = getSettings();
    return !!(settings.confluenceBaseUrl && settings.confluencePat);
  },

  getSpaceKeyOrParent(): string {
    return getSettings().confluenceSpaceKey;
  },

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const settings = getSettings();
      if (!settings.confluenceBaseUrl || !settings.confluencePat) {
        return { ok: false, error: 'Confluence base URL and PAT are required' };
      }

      const url = `${settings.confluenceBaseUrl}/rest/api/space/${settings.confluenceSpaceKey}`;
      const res = await fetchWithVpnCheck(url, {
        headers: {
          Authorization: `Bearer ${settings.confluencePat}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        if (res.status === 401) return { ok: false, error: 'Invalid PAT' };
        return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
        return { ok: false, error: 'Connection failed — are you on the VPN?' };
      }
      return { ok: false, error: msg };
    }
  },
};
