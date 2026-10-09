import { beforeEach, describe, expect, it, vi } from 'vitest';
import { linearDocsProvider, withLinearDocsApiKey } from '../linear-docs.service.js';

const { getMockSettings } = vi.hoisted(() => ({
  getMockSettings: vi.fn(() => ({ linearApiKey: 'test-linear-key' })),
}));

vi.mock('../settings.service.js', () => ({ getSettings: getMockSettings }));

type GraphqlRequest = { query: string; variables?: Record<string, unknown> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('linearDocsProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getMockSettings.mockReturnValue({ linearApiKey: 'test-linear-key' });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lists all document pages using cursors and maps Linear document fields', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            documents: {
              nodes: [
                {
                  id: 'doc-1',
                  title: 'Architecture',
                  url: 'https://linear.app/acme/document/doc-1',
                  updatedAt: '2026-09-01T00:00:00.000Z',
                  updatedBy: { name: 'Ada' },
                  project: { id: 'project-1', name: 'Anvil' },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            documents: {
              nodes: [
                { id: 'doc-2', title: 'Notes', url: 'https://linear.app/acme/document/doc-2' },
              ],
              pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
            },
          },
        }),
      );

    const pages = await linearDocsProvider.listPages();
    expect(pages).toEqual([
      expect.objectContaining({
        id: 'doc-1',
        title: 'Architecture',
        lastUpdatedBy: 'Ada',
        projectId: 'project-1',
        projectName: 'Anvil',
        provider: 'linear',
      }),
      expect.objectContaining({ id: 'doc-2', title: 'Notes', provider: 'linear' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as GraphqlRequest;
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as GraphqlRequest;
    expect(firstRequest.variables).toMatchObject({ first: 100 });
    expect(secondRequest.variables).toMatchObject({ after: 'cursor-1' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('test-linear-key');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('test-linear-key');
  });

  it('filters documents by project when a project scope is supplied', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { documents: { nodes: [], pageInfo: { hasNextPage: false } } } }),
    );

    await linearDocsProvider.listPages('project-42');
    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as GraphqlRequest;
    expect(request.variables?.filter).toEqual({ project: { id: { eq: 'project-42' } } });
  });

  it('reads markdown content and creates or updates a project document', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { document: { content: '# Read me' } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            documentCreate: {
              success: true,
              document: { id: 'new-id', url: 'https://linear.app/acme/document/new-id' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { documentUpdate: { success: true } } }));

    await expect(linearDocsProvider.getPageContent('doc-1')).resolves.toBe('# Read me');
    await expect(linearDocsProvider.createPage('project-1', 'New page', '# Body')).resolves.toBe(
      'https://linear.app/acme/document/new-id',
    );
    await expect(
      linearDocsProvider.updatePage('doc-1', 'Updated title', '# Updated'),
    ).resolves.toBe(undefined);

    const createRequest = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as GraphqlRequest;
    const updateRequest = JSON.parse(String(fetchMock.mock.calls[2][1].body)) as GraphqlRequest;
    expect(createRequest.variables?.input).toEqual({
      title: 'New page',
      content: '# Body',
      projectId: 'project-1',
    });
    expect(updateRequest.variables).toEqual({
      id: 'doc-1',
      input: { title: 'Updated title', content: '# Updated' },
    });
  });

  it('requires a project for document creation', async () => {
    await expect(linearDocsProvider.createPage('', 'New page', '# Body')).rejects.toThrow(
      'Choose a Linear project before creating a document.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paginates project choices and reports GraphQL and credential failures clearly', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            projects: {
              nodes: [{ id: 'project-1', name: 'Anvil' }],
              pageInfo: { hasNextPage: true, endCursor: 'next-projects' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            projects: {
              nodes: [{ id: 'project-2', name: 'Companion' }],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      );
    await expect(linearDocsProvider.listProjects!()).resolves.toEqual([
      { id: 'project-1', name: 'Anvil' },
      { id: 'project-2', name: 'Companion' },
    ]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'Not authorized' }] }));
    await expect(linearDocsProvider.getPageContent('doc-1')).rejects.toThrow(
      'Linear GraphQL error: Not authorized',
    );

    getMockSettings.mockReturnValue({ linearApiKey: '' });
    await expect(linearDocsProvider.getPageContent('doc-1')).rejects.toThrow(
      'Linear API key must be configured in Work Items settings.',
    );
  });

  it('keeps work bound to the Linear key captured before an async pause', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          projects: {
            nodes: [{ id: 'project-1', name: 'Anvil' }],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    );

    const work = withLinearDocsApiKey('captured-account-key', async () => {
      await paused;
      return linearDocsProvider.listProjects!();
    });
    getMockSettings.mockReturnValue({ linearApiKey: 'switched-account-key' });
    release();

    await expect(work).resolves.toEqual([{ id: 'project-1', name: 'Anvil' }]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('captured-account-key');
  });
});
