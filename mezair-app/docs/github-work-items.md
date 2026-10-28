# GitHub Work Items setup

GitHub issues can be used as Work Items alongside Azure DevOps, Linear and Jira.
Each named GitHub connection selects one repository.

1. Open Settings → Delivery → Work Items and add a named connection.
2. Select GitHub. Enter the HTTPS GitHub host, owner and repository. Use
   `https://github.com` for GitHub.com, or your GitHub Enterprise HTTPS origin.
3. Enter a personal access token with access to that repository's issues. Reading
   needs issue read access; creating issues or posting comments needs issue write
   access. This token belongs to the Work Item connection and is separate from
   GitHub Code settings.
4. Save the connection, test it, and select it as the active connection. Open
   Work Items to browse issues and filter by state, labels, assignee or milestone.

Pull requests are excluded. Milestones appear as iterations. Creating a Work Item
creates a repository issue; parent issue creation is unsupported. Issue type is
inferred from labels such as `bug`, `feature`, `epic` and `story`.

GitHub Work Item identities are full issue URLs, for example
`https://github.com/acme/widgets/issues/42`. Use that URL when attaching a shared
thread to a GitHub issue. Search also accepts `42` or `#42`, scoped to the selected
connection. Canonical service references require the full URL and reject bare
numbers or URLs from another repository. Posting a review or share link requires
an explicit publication action; an uncertain result must be checked on GitHub
before retrying.

Software factories currently intake GitHub issues through their separately
reviewed repository and label configuration. Adding Work Item connections does
not extend factory intake to Jira, Linear or Azure DevOps; that requires a
separately approved implementation of source identity, polling and permissions.
