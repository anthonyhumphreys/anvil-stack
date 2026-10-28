import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock('../workitem-context.service.js', () => ({ getWorkItemSettings: () => state.settings }));
import {
  publishWorkItemLink,
  publishWorkItemReview,
} from '../workitem-review-publication.service.js';

afterEach(() => vi.unstubAllGlobals());

describe('explicit Work Item review publication', () => {
  it('resolves Linear identifiers before publishing and checks the mutation result', async () => {
    state.settings = { workItemProvider: 'linear', linearApiKey: 'test-key' };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { issue: { id: 'uuid' } } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { commentCreate: { success: false } } }),
      });
    vi.stubGlobal('fetch', request);
    await expect(publishWorkItemReview('ANV-1', 'Reviewed')).rejects.toThrow('did not confirm');
    expect(JSON.parse(request.mock.calls[1][1].body).variables.input).toEqual({
      issueId: 'uuid',
      body: 'Reviewed',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['cloud', 'server'])('uses the Jira %s comment format', async (mode) => {
    state.settings = {
      workItemProvider: 'jira',
      jiraAuthMode: mode,
      jiraHost: 'https://jira.example',
      jiraApiToken: 'test-token',
      jiraEmail: 'review@example.test',
    };
    const request = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', request);
    await publishWorkItemReview('APP-1', 'Checked\n\nAccepted');
    const [url, options] = request.mock.calls[0];
    expect(url).toContain(`/rest/api/${mode === 'server' ? '2' : '3'}/issue/APP-1/comment`);
    const body = JSON.parse(options.body).body;
    if (mode === 'server') expect(body).toBe('Checked\n\nAccepted');
    else expect(body.content).toHaveLength(3);
    expect(options.redirect).toBe('error');
  });

  it('posts Azure DevOps markdown once and does not retry an ambiguous failure', async () => {
    state.settings = {
      workItemProvider: 'ado',
      adoOrganizationUrl: 'https://dev.azure.com/example/',
      adoProject: 'Test project',
      adoPat: 'test-token',
    };
    const request = vi.fn().mockRejectedValue(new Error('Connection lost'));
    vi.stubGlobal('fetch', request);
    await expect(publishWorkItemReview('42', 'Reviewed')).rejects.toThrow('outcome is unknown');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('/Test%20project/_apis/wit/workItems/42/comments?');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ text: 'Reviewed' });
  });

  it('uses Jira ADF link marks and preserves the complete bearer URL fragment', async () => {
    state.settings = {
      workItemProvider: 'jira',
      jiraAuthMode: 'cloud',
      jiraHost: 'https://jira.example.test',
      jiraApiToken: 'token',
      jiraEmail: 'person@example.test',
    };
    const request = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', request);
    const fullUrl = 'https://share.example.test/artifacts/id#k=one-time-secret';
    await publishWorkItemLink(
      'ANV-4',
      'Mezair thread shared: Design review\nAudience: Team\nShared: 2026-10-25',
      'Design review',
      fullUrl,
    );
    const body = JSON.parse(request.mock.calls[0][1].body).body;
    expect(body.content.at(-1).content[0]).toEqual({
      type: 'text',
      text: 'Design review',
      marks: [{ type: 'link', attrs: { href: fullUrl } }],
    });
  });
});
