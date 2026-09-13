import { getWorkItemSettings } from './workitem-context.service.js';

/** Called only by the provider after the user chooses Publish. Never retry a POST automatically. */
export async function publishWorkItemReview(id: string, text: string): Promise<void> {
  const s = getWorkItemSettings();
  let url: string;
  let body: unknown;
  let headers: Record<string, string>;
  if (s.workItemProvider === 'linear') {
    url = 'https://api.linear.app/graphql';
    headers = { Authorization: s.linearApiKey ?? '', 'Content-Type': 'application/json' };
    const lookup = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        query: 'query($id: String!) { issue(id: $id) { id } }',
        variables: { id },
      }),
    });
    if (!lookup.ok) throw new Error(`Linear lookup failed: ${lookup.status}`);
    const item = (await lookup.json()) as { data?: { issue?: { id: string } }; errors?: unknown[] };
    if (item.errors?.length || !item.data?.issue?.id)
      throw new Error('Linear issue could not be resolved.');
    body = {
      query: 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
      variables: { input: { issueId: item.data.issue.id, body: text } },
    };
  } else if (s.workItemProvider === 'ado') {
    url = `${s.adoOrganizationUrl.replace(/\/$/, '')}/${encodeURIComponent(s.adoProject)}/_apis/wit/workItems/${encodeURIComponent(id)}/comments?api-version=7.1-preview.4&format=markdown`;
    headers = {
      Authorization: `Basic ${Buffer.from(`:${s.adoPat ?? ''}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    body = { text };
  } else if (s.workItemProvider === 'jira') {
    const version = s.jiraAuthMode === 'server' ? '2' : '3';
    const host = s.jiraHost?.replace(/\/$/, '') ?? '';
    url = `${host.startsWith('http') ? host : `https://${host}`}/rest/api/${version}/issue/${encodeURIComponent(id)}/comment`;
    headers = {
      Authorization:
        s.jiraAuthMode === 'server'
          ? `Bearer ${s.jiraApiToken ?? ''}`
          : `Basic ${Buffer.from(`${s.jiraEmail ?? ''}:${s.jiraApiToken ?? ''}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    body = {
      body:
        version === '2'
          ? text
          : {
              type: 'doc',
              version: 1,
              content: text
                .split('\n')
                .map((line) => ({
                  type: 'paragraph',
                  content: line ? [{ type: 'text', text: line }] : [],
                })),
            },
    };
  } else throw new Error('This provider does not support review publication.');
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `Review publication returned HTTP ${response.status}. Check the Work Item before retrying.`,
    );
  if (s.workItemProvider === 'linear') {
    const result = (await response.json()) as {
      data?: { commentCreate?: { success: boolean } };
      errors?: unknown[];
    };
    if (result.errors?.length || !result.data?.commentCreate?.success)
      throw new Error('Linear did not confirm review publication.');
  }
}
