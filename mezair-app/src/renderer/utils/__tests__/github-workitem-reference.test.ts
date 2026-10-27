import { describe, expect, it } from 'vitest';
import { normalizeGitHubIssueUrl } from '../github-workitem-reference';

const connection = {
  githubHost: 'https://github.com',
  githubOwner: 'Acme',
  githubRepo: 'Widget',
};

describe('normalizeGitHubIssueUrl', () => {
  it('normalizes owner and repository casing for the selected connection', () => {
    expect(
      normalizeGitHubIssueUrl('https://github.com/ACME/Widget/issues/42', connection),
    ).toBe('https://github.com/acme/widget/issues/42');
  });

  it('rejects URLs for another host, repository, or issue URL shape', () => {
    expect(
      normalizeGitHubIssueUrl('https://github.com/acme/other/issues/42', connection),
    ).toBeUndefined();
    expect(
      normalizeGitHubIssueUrl('https://github.com.evil.test/acme/widget/issues/42', connection),
    ).toBeUndefined();
    expect(
      normalizeGitHubIssueUrl('https://github.com/acme/widget/pull/42', connection),
    ).toBeUndefined();
  });

  it('supports an enterprise host while retaining its canonical origin', () => {
    expect(
      normalizeGitHubIssueUrl('https://git.example.test/ACME/Widget/issues/7', {
        ...connection,
        githubHost: 'https://git.example.test',
      }),
    ).toBe('https://git.example.test/acme/widget/issues/7');
  });
});
