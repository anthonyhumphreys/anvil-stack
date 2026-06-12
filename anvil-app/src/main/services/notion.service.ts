import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DocPage, NotionPage } from '../../shared/types.js';
import type { DocsProviderService } from './docs-provider.js';
import { getSettings, updateSettings } from './settings.service.js';

const execFileAsync = promisify(execFile);

const NOTION_MCP_NAME = 'notion';
const NOTION_OAUTH_CLIENT_ID = 'notion-mcp-oauth';

interface NotionPageResponse {
  object: string;
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  parent: { type: string; database_id?: string; page_id?: string };
  properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }>;
}

interface NotionBlockResponse {
  object: string;
  type: string;
  [key: string]: unknown;
}

function getNotionToken(): string | null {
  const settings = getSettings();
  if (!settings.notionOauthToken) return null;
  if (settings.notionOauthExpiry) {
    const expiry = new Date(settings.notionOauthExpiry);
    if (expiry < new Date()) return null;
  }
  return settings.notionOauthToken;
}

function getAuthHeaders(): Record<string, string> | null {
  const token = getNotionToken();
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

async function notionFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = getAuthHeaders();
  if (!headers)
    throw new Error('Notion not authenticated. Connect Notion in Settings or Onboarding.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function extractPageTitle(page: NotionPageResponse): string {
  const props = page.properties;
  for (const value of Object.values(props)) {
    if (value.type === 'title' && value.title && value.title.length > 0) {
      return value.title[0].plain_text;
    }
  }
  return 'Untitled';
}

async function blockToMarkdown(blocks: NotionBlockResponse[], indent = 0): Promise<string> {
  const lines: string[] = [];
  const pad = '  '.repeat(indent);

  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph': {
        const text =
          (block.paragraph as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}${text}`);
        break;
      }
      case 'heading_1': {
        const text =
          (block.heading_1 as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}# ${text}`);
        break;
      }
      case 'heading_2': {
        const text =
          (block.heading_2 as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}## ${text}`);
        break;
      }
      case 'heading_3': {
        const text =
          (block.heading_3 as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}### ${text}`);
        break;
      }
      case 'bulleted_list_item': {
        const text =
          (block.bulleted_list_item as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}- ${text}`);
        break;
      }
      case 'numbered_list_item': {
        const text =
          (block.numbered_list_item as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}1. ${text}`);
        break;
      }
      case 'to_do': {
        const td = block.to_do as { rich_text?: Array<{ plain_text: string }>; checked?: boolean };
        const text = td.rich_text?.map((t) => t.plain_text).join('') ?? '';
        lines.push(`${pad}- [${td.checked ? 'x' : ' '}] ${text}`);
        break;
      }
      case 'code': {
        const code = block.code as { rich_text?: Array<{ plain_text: string }>; language?: string };
        const text = code.rich_text?.map((t) => t.plain_text).join('') ?? '';
        lines.push(`${pad}\`\`\`${code.language ?? ''}`);
        lines.push(`${pad}${text}`);
        lines.push(`${pad}\`\`\``);
        break;
      }
      case 'quote': {
        const text =
          (block.quote as { rich_text?: Array<{ plain_text: string }> })?.rich_text
            ?.map((t) => t.plain_text)
            .join('') ?? '';
        lines.push(`${pad}> ${text}`);
        break;
      }
      case 'divider': {
        lines.push(`${pad}---`);
        break;
      }
      case 'image': {
        const img = block.image as {
          type?: string;
          file?: { url?: string };
          external?: { url?: string };
        };
        const url = img.type === 'file' ? img.file?.url : img.external?.url;
        if (url) lines.push(`${pad}![image](${url})`);
        break;
      }
    }
  }

  return lines.join('\n');
}

export async function isNotionMcpInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 10000 });
    return stdout.includes(NOTION_MCP_NAME);
  } catch {
    return false;
  }
}

export async function installNotionMcp(): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync(
      'codex',
      [
        'mcp',
        'add',
        NOTION_MCP_NAME,
        '--transport',
        'http',
        '--header',
        'Authorization: Bearer $NOTION_TOKEN',
        'https://mcp.notion.com/mcp',
      ],
      {
        timeout: 30000,
        env: { ...process.env, NOTION_TOKEN: getNotionToken() ?? '' },
      },
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function startNotionOAuthFlow(): Promise<{ authUrl: string; state: string }> {
  const state = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const redirectUri = 'http://localhost:3000/notion/oauth/callback';
  const authUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${NOTION_OAUTH_CLIENT_ID}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  return { authUrl, state };
}

export async function exchangeNotionOAuthCode(
  code: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:3000/notion/oauth/callback',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { success: false, error: `OAuth exchange failed: ${res.status} ${body}` };
    }

    const data = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in?: number;
      owner?: { user?: { id: string } };
    };

    const expiry = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;

    updateSettings({
      notionOauthToken: data.access_token,
      notionOauthExpiry: expiry,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchPages(query = ''): Promise<NotionPage[]> {
  const res = await notionFetch('https://api.notion.com/v1/search', {
    method: 'POST',
    body: JSON.stringify({
      query,
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 100,
    }),
  });

  if (!res.ok) {
    throw new Error(`Notion search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { results: NotionPageResponse[] };
  return data.results.map((page) => ({
    id: page.id,
    title: extractPageTitle(page),
    url: page.url,
    lastUpdated: page.last_edited_time,
    lastUpdatedBy: 'Notion User',
    parentId: page.parent?.page_id,
    provider: 'notion' as const,
  }));
}

async function listPageChildren(pageId: string): Promise<NotionPage[]> {
  const res = await notionFetch('https://api.notion.com/v1/blocks', {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'object', value: 'page' },
    }),
  });

  if (!res.ok) {
    throw new Error(`Notion list children failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { results: NotionPageResponse[] };
  return data.results
    .filter((p) => p.parent?.page_id === pageId)
    .map((page) => ({
      id: page.id,
      title: extractPageTitle(page),
      url: page.url,
      lastUpdated: page.last_edited_time,
      lastUpdatedBy: 'Notion User',
      parentId: page.parent?.page_id,
      provider: 'notion' as const,
    }));
}

async function getPageContent(pageId: string): Promise<string> {
  const res = await notionFetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
  );

  if (!res.ok) {
    throw new Error(`Notion get page content failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { results: NotionBlockResponse[] };
  return blockToMarkdown(data.results);
}

async function createPage(parentPageId: string, title: string, content: string): Promise<string> {
  const blocks = content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return {
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: trimmed.slice(2) } }] },
      };
    }
    if (trimmed.startsWith('## ')) {
      return {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: trimmed.slice(3) } }] },
      };
    }
    if (trimmed.startsWith('- ')) {
      return {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: trimmed.slice(2) } }] },
      };
    }
    if (trimmed === '---') {
      return { object: 'block', type: 'divider', divider: {} };
    }
    if (trimmed.length === 0) {
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [] },
      };
    }
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: trimmed } }] },
    };
  });

  const res = await notionFetch(`https://api.notion.com/v1/blocks/${parentPageId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children: blocks }),
  });

  if (!res.ok) {
    throw new Error(`Notion create page failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { results: Array<{ id: string }> };
  return `https://notion.so/${data.results[0]?.id ?? parentPageId}`;
}

export const notionProvider: DocsProviderService = {
  async listPages(): Promise<DocPage[]> {
    return searchPages();
  },

  async listChildren(pageId: string): Promise<DocPage[]> {
    return listPageChildren(pageId);
  },

  async getPageContent(pageId: string): Promise<string> {
    return getPageContent(pageId);
  },

  async checkStaleness(pageId: string, repoLastCommitDate: string): Promise<DocPage['staleness']> {
    const res = await notionFetch(`https://api.notion.com/v1/pages/${pageId}`);
    if (!res.ok) return 'unknown';

    const data = (await res.json()) as { last_edited_time: string };
    const pageDate = new Date(data.last_edited_time ?? 0);
    const repoDate = new Date(repoLastCommitDate);
    const diffDays = (repoDate.getTime() - pageDate.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > 7 ? 'stale' : 'current';
  },

  async createPage(spaceKeyOrParent: string, title: string, content: string): Promise<string> {
    return createPage(spaceKeyOrParent, title, content);
  },

  async updatePage(pageId: string, title: string, content: string): Promise<void> {
    await notionFetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
      }),
    });

    const blocks = content.split('\n').map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        return {
          object: 'block',
          type: 'heading_1',
          heading_1: { rich_text: [{ type: 'text', text: { content: trimmed.slice(2) } }] },
        };
      }
      if (trimmed.startsWith('## ')) {
        return {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: trimmed.slice(3) } }] },
        };
      }
      if (trimmed.startsWith('- ')) {
        return {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: trimmed.slice(2) } }],
          },
        };
      }
      if (trimmed === '---') {
        return { object: 'block', type: 'divider', divider: {} };
      }
      if (trimmed.length === 0) {
        return { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } };
      }
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: trimmed } }] },
      };
    });

    await notionFetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: blocks }),
    });
  },

  isConfigured(): boolean {
    return getNotionToken() !== null;
  },

  getSpaceKeyOrParent(): string {
    return getSettings().notionDatabaseId ?? '';
  },

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = getNotionToken();
      if (!token) return { ok: false, error: 'Notion not authenticated' };

      const res = await notionFetch('https://api.notion.com/v1/users/me');
      if (!res.ok) {
        if (res.status === 401) return { ok: false, error: 'Invalid or expired Notion token' };
        return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
