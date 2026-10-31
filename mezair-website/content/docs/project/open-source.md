---
title: Open source
navTitle: Open source
description: Find Mezair's source code, understand its MIT licence and check the limits of each project.
product: Project
section: Concepts
journey: reference
order: 10
---

# Open source

Mezair Desktop, Registry, Node Base, Cloud and this website are open source. You can read the code, run the tools on your own infrastructure and contribute changes.

The docs link to setup commands, source files and known limits so you can check how a feature works before relying on it.

## Repository

Everything lives in the [`mezair`](https://github.com/anthonyhumphreys/mezair) monorepo, organised as independent project workspaces:

- `mezair-app/`: Mezair Desktop, the local Electron workspace.
- `mezair-registry/`: Mezair Registry and Mezair Node Base.
- `mezair-cloud/`: Mezair Cloud, the beta Cell runtime and adapter platform.
- `mezair-website/`: this public docs site.

The [monorepo map](/docs/project/repositories) explains what each directory owns and how to build it.

## License

Everything in the monorepo is [MIT licensed](https://github.com/anthonyhumphreys/mezair/blob/main/LICENSE).

## Check the current status

All Mezair products are currently in beta. Start with the status page for the tool you want to use:

- [Registry beta status](/docs/registry/beta-status)
- [Cloud status and limits](/docs/cloud/status-and-limits)
- [Sync & Mesh status and limits](/docs/sync/status-and-limits)

Agents and automated checks help you inspect work. You still need to review changes, validate findings and decide what to run or deploy.

## Contribute

Documentation lives in Markdown alongside the code. Report an unclear guide or suggest a correction through the [contribution guide](/docs/project/contributing).
