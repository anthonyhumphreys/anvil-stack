import { describe, expect, it } from 'vitest';
import { presentPullRequestError } from '../pull-request-error';
describe('pull request errors', () => {
  it('explains a missing remote without Electron transport details', () => {
    expect(
      presentPullRequestError(
        new Error(
          "Error invoking remote method 'codereview:listPullRequests': Error: Pull request mode requires a repository with a GitHub or Azure DevOps remote.",
        ),
      ),
    ).toBe(
      'This repository needs a GitHub or Azure DevOps remote before you can link a pull request.',
    );
  });
  it('retains actionable provider errors', () => {
    expect(
      presentPullRequestError(
        "Error: Error invoking remote method 'chat:link': Error: Sign in to GitHub and try again.",
      ),
    ).toBe('Sign in to GitHub and try again.');
  });
});
