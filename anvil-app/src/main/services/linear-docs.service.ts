import { AsyncLocalStorage } from 'node:async_hooks';
import type { DocPage, LinearDocPage, LinearDocProject } from '../../shared/types.js';
import type { DocsProviderService } from './docs-provider.js';
import { getSettings } from './settings.service.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const PAGE_SIZE = 100;
const requestApiKey = new AsyncLocalStorage<string>();

/** Keep every Linear request in one docs operation on the same captured account. */
export function withLinearDocsApiKey<T>(apiKey: string, action: () => Promise<T>): Promise<T> {
  return requestApiKey.run(apiKey, action);
}

interface LinearDocument {
  id: string;
  title: string;
  content?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  updatedBy?: { name?: string | null } | null;
  creator?: { name?: string | null } | null;
  project?: { id: string; name: string } | null;
}

interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

interface LinearGraphqlResult<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

function getApiKey(): string {
  const apiKey = requestApiKey.getStore() ?? getSettings().linearApiKey?.trim();
  if (!apiKey) {
    throw new Error('Linear API key must be configured in Work Items settings.');
  }
  return apiKey;
}

async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  apiKey = getApiKey(),
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Linear request timed out. Check your connection and try again.');
    }
    throw new Error(
      `Could not reach Linear: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Linear rejected the API key. Check the active Linear connection in Settings.',
      );
    }
    throw new Error(
      `Linear request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''})${detail ? `: ${detail}` : ''}`,
    );
  }

  const result = (await response.json()) as LinearGraphqlResult<T>;
  if (result.errors?.length) {
    throw new Error(
      `Linear GraphQL error: ${result.errors.map((error) => error.message ?? 'Unknown error').join('; ')}`,
    );
  }
  if (!result.data) throw new Error('Linear returned an empty GraphQL response.');
  return result.data;
}

function mapDocument(document: LinearDocument): LinearDocPage {
  return {
    id: document.id,
    title: document.title,
    url: document.url ?? '',
    lastUpdated: document.updatedAt ?? '',
    lastUpdatedBy: document.updatedBy?.name ?? document.creator?.name ?? '',
    staleness: 'unknown',
    projectId: document.project?.id,
    projectName: document.project?.name,
    provider: 'linear',
  };
}

async function listDocuments(projectId?: string): Promise<DocPage[]> {
  const apiKey = getApiKey();
  const pages: DocPage[] = [];
  let after: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql<{
      documents: { nodes: LinearDocument[]; pageInfo: LinearPageInfo };
    }>(
      `
        query ListDocuments($first: Int!, $after: String, $filter: DocumentFilter) {
          documents(first: $first, after: $after, filter: $filter) {
            nodes {
              id
              title
              url
              updatedAt
              updatedBy {
                name
              }
              creator {
                name
              }
              project {
                id
                name
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        first: PAGE_SIZE,
        after,
        filter: projectId ? { project: { id: { eq: projectId } } } : undefined,
      },
      apiKey,
    );
    pages.push(...data.documents.nodes.map(mapDocument));
    hasNextPage = data.documents.pageInfo.hasNextPage;
    after = data.documents.pageInfo.endCursor ?? undefined;
    if (hasNextPage && !after)
      throw new Error('Linear pagination returned no cursor for the next page.');
  }

  return pages;
}

async function listProjects(): Promise<LinearDocProject[]> {
  const apiKey = getApiKey();
  const projects: LinearDocProject[] = [];
  let after: string | undefined;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await graphql<{
      projects: { nodes: LinearDocProject[]; pageInfo: LinearPageInfo };
    }>(
      `
        query ListProjects($first: Int!, $after: String) {
          projects(first: $first, after: $after) {
            nodes {
              id
              name
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { first: PAGE_SIZE, after },
      apiKey,
    );
    projects.push(...data.projects.nodes);
    hasNextPage = data.projects.pageInfo.hasNextPage;
    after = data.projects.pageInfo.endCursor ?? undefined;
    if (hasNextPage && !after)
      throw new Error('Linear pagination returned no cursor for the next page.');
  }
  return projects;
}

export const linearDocsProvider: DocsProviderService = {
  listPages: (projectId) => listDocuments(projectId),

  async listChildren(): Promise<DocPage[]> {
    // Linear documents have project or issue associations rather than page nesting.
    return [];
  },

  async listProjects(): Promise<LinearDocProject[]> {
    return listProjects();
  },

  async getPageContent(pageId: string): Promise<string> {
    const data = await graphql<{ document: Pick<LinearDocument, 'content'> | null }>(
      `
        query GetDocument($id: String!) {
          document(id: $id) {
            content
          }
        }
      `,
      { id: pageId },
    );
    if (!data.document)
      throw new Error(`Linear document ${pageId} was not found or is inaccessible.`);
    return data.document.content ?? '';
  },

  async checkStaleness(pageId: string, repoLastCommitDate: string): Promise<DocPage['staleness']> {
    const data = await graphql<{ document: Pick<LinearDocument, 'updatedAt'> | null }>(
      `
        query GetDocumentUpdatedAt($id: String!) {
          document(id: $id) {
            updatedAt
          }
        }
      `,
      { id: pageId },
    );
    if (!data.document?.updatedAt) return 'unknown';
    const diffDays =
      (new Date(repoLastCommitDate).getTime() - new Date(data.document.updatedAt).getTime()) /
      (1000 * 60 * 60 * 24);
    return diffDays > 7 ? 'stale' : 'current';
  },

  async createPage(projectId: string, title: string, content: string): Promise<string> {
    if (!projectId) throw new Error('Choose a Linear project before creating a document.');
    const data = await graphql<{
      documentCreate: { success: boolean; document?: Pick<LinearDocument, 'id' | 'url'> | null };
    }>(
      `
        mutation CreateDocument($input: DocumentCreateInput!) {
          documentCreate(input: $input) {
            success
            document {
              id
              url
            }
          }
        }
      `,
      { input: { title, content, projectId } },
    );
    const created = data.documentCreate;
    if (!created.success || !created.document)
      throw new Error('Linear did not create the document.');
    if (!created.document.url) throw new Error('Linear created the document but returned no URL.');
    return created.document.url;
  },

  async updatePage(pageId: string, title: string, content: string): Promise<void> {
    const data = await graphql<{
      documentUpdate: { success: boolean; document?: { id: string } | null };
    }>(
      `
        mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
          documentUpdate(id: $id, input: $input) {
            success
            document {
              id
            }
          }
        }
      `,
      { id: pageId, input: { title, content } },
    );
    if (!data.documentUpdate.success) throw new Error('Linear did not update the document.');
  },

  isConfigured(): boolean {
    return Boolean(getSettings().linearApiKey?.trim());
  },

  getSpaceKeyOrParent(): string {
    return '';
  },

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await graphql<{ viewer: { id: string } }>(`
        query TestConnection {
          viewer {
            id
          }
        }
      `);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
