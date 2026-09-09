/** Keep actionable provider messages without Electron's transport wrapper. */
export function presentPullRequestError(reason: unknown): string {
  const message = (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error:\s*/i, '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  if (
    /requires a repository with a GitHub or Azure DevOps remote|needs a linked workspace and remote/i.test(
      message,
    )
  ) {
    return 'This repository needs a GitHub or Azure DevOps remote before you can link a pull request.';
  }
  return message || 'The pull request could not be loaded. Try again.';
}
