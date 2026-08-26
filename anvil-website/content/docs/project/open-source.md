---
title: Open source posture
navTitle: OSS posture
description: How to read Anvil's scope, claims, and security posture.
product: Project
section: Notes
journey: reference
order: 900
---

# Open source posture

Anvil is open source infrastructure for developers who want local control, inspectable decisions, and fewer mystery boxes in the delivery path.

The site should be read as product documentation first and marketing second. Claims need receipts: commands, architecture, policy inputs, lifecycle evidence, package reports, or explicit limits.

## Repository

Everything lives in the [`anvil-stack`](https://github.com/anthonyhumphreys/anvil-stack) monorepo, organised as independent project workspaces:

- `anvil-app/`: Anvil Desktop, the local Electron workspace.
- `anvil-registry/`: Anvil Registry and Anvil Node Base.
- `anvil-cloud/`: Anvil Cloud, the alpha Cell runtime and adapter platform.
- `anvil-website/`: this public docs site.

Read the [monorepo map](/docs/project/repositories) before assuming a feature belongs in a particular project.

## License

Everything in the monorepo is [MIT licensed](https://github.com/anthonyhumphreys/anvil-stack/blob/main/LICENSE).

## What to expect

- Practical setup paths.
- Plain-language security reasoning.
- Sharp scope boundaries.
- Markdown docs that can be reviewed in Git.
- Honest alpha notes where a feature is early.

## What not to expect

- Glossy cybersecurity vendor theatre.
- SaaS dashboard language grafted onto local tools.
- Fake metrics with no source.
- Claims that agents, LLMs, or heuristics remove human review.
- Hosted-platform claims that go beyond the current Cloud adapter and operations work.

Anvil is allowed to have a point of view. It is not allowed to pretend uncertainty does not exist.
