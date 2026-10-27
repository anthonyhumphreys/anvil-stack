---
title: Start here
navTitle: Overview
description: What each part of Anvil does, which one you need, and where to go next.
product: Start here
section: Start here
journey: learn
order: 10
---

# Start here

Anvil is a set of open-source tools for running coding agents on your own machines, and for checking their work before you trust it. Everything lives in one repository, and every part can be used on its own.

## Which part do you need?

| If you want to… | Use | Read first |
| --- | --- | --- |
| Run Codex, Cursor, Devin or OpenAI agents on your repos, and review what they change | Anvil Desktop | [Install Anvil Desktop](/docs/desktop/installation) |
| Keep your Anvil setup in step across machines, or send work from one machine to another | Sync & Mesh | [How Sync & Mesh works](/docs/sync/overview) |
| Check npm packages against a policy before they reach developers or CI | Anvil Registry | [Registry quickstart](/docs/registry/quickstart) |
| Install dependencies for a repo you don't trust yet | Anvil Node Base | [Safe mode](/docs/node-base/safe-mode) |
| Build small apps and agents locally, then deploy them through an adapter | Anvil Cloud | [Cloud quickstart](/docs/cloud/quickstart) |

They're separate because they solve separate problems. Desktop looks after your local work. Sync & Mesh connects your machines. Registry decides which packages get in. Node Base contains package installs. Cloud defines a small, portable app runtime.

## Where the code lives

The [anvil-stack repository](https://github.com/anthonyhumphreys/anvil-stack) holds four projects:

- **anvil-app**: Anvil Desktop, the Electron app, plus the desktop side of Sync & Mesh.
- **anvil-registry**: Anvil Registry and Anvil Node Base.
- **anvil-cloud**: Anvil Cloud, plus the Sync & Mesh backend you can deploy yourself.
- **anvil-website**: this site and these docs.

Each project has its own lockfile and tooling. Install dependencies inside the project folder, not at the repository root.

## Run each one from source

| Tool | Commands |
| --- | --- |
| Anvil Desktop | `cd anvil-app && pnpm install && pnpm dev` |
| Anvil Registry | `cd anvil-registry && pnpm install --ignore-scripts && docker compose -f infra/docker/docker-compose.yml up --build` |
| Anvil Node Base | `docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/anthonyhumphreys/anvil-stack/anvil-node-base:22 anvil-npm-ci-safe` |
| Anvil Cloud | `cd anvil-cloud && pnpm install --ignore-scripts && pnpm build && pnpm anvil-cloud --help` |

If you'd rather install the command-line tools, start with the [Anvil CLI](/docs/cli):

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli
npm install --global @anvilstack/registry-cli

anvil cloud check --json
anvil registry doctor
```

## Find a page by task

| Task | Page |
| --- | --- |
| See which folder owns what | [Monorepo map](/docs/project/repositories) |
| Use the command line | [Anvil CLI](/docs/cli) |
| Get a tour of the desktop app | [Desktop overview](/docs/desktop/overview) |
| Understand how the desktop app is built | [Desktop architecture](/docs/desktop/architecture) |
| Plan, build and review with an agent | [Agent workflows](/docs/desktop/agent-workflows) |
| Take GitHub issues to confirmed merges under a policy you activate (beta through 30 November 2026) | [User-definable software factories](/docs/desktop/software-factories) |
| Choose providers, models and personas | [Chat, personas and models](/docs/desktop/chat-personas-and-llm) |
| Work with branches and commits | [Git workflows](/docs/desktop/git-workflows) |
| Review code and security findings | [Security and review](/docs/desktop/security-and-review) |
| Use your phone, watch, Raycast or the menu bar | [Companion surfaces](/docs/desktop/companion-surfaces) |
| Sync your devices and run jobs on your own machines | [Sync & Mesh](/docs/sync/overview) |
| See how Mesh prefers your LAN and switches routes (beta through 30 November 2026) | [LAN-first Mesh routes](/docs/sync/lan-first-routes) |
| Try the registry locally | [Registry quickstart](/docs/registry/quickstart) |
| Understand why a package was allowed or blocked | [Package decisions](/docs/registry/package-decisions) |
| See what package analysis looks for | [Worker analysis](/docs/registry/worker-analysis) |
| Roll the registry out to a team | [Registry rollout guide](/docs/registry/rollout-guide) |
| Contribute to Registry or Node Base | [Contributing to Anvil Registry](/docs/registry/contributing) |
| Use the hardened Node image | [Node Base overview](/docs/node-base/overview) |
| Build your first Cell | [Cloud quickstart](/docs/cloud/quickstart) |
| Understand what a Cell can declare | [Cell contract](/docs/cloud/cell-contract) |
| Give an agent a clear set of permissions | [Anvil Agents](/docs/cloud/agents) |
| Run an agent in an isolated workspace | [Agent Sandboxes](/docs/cloud/agent-sandboxes) |
| Add sign-in to a Cell | [Cloud auth](/docs/cloud/auth) |
| Run multi-step workflows that survive restarts | [Cloud workflows](/docs/cloud/workflows) |
| Run long-lived background services | [Cloud services](/docs/cloud/services) |
| Manage a Cell from a local UI | [Anvil Lens](/docs/cloud/lens) |
| Run and inspect a Cell locally | [Local runtime](/docs/cloud/local-runtime) |
| Understand the build checks | [Builder and Guard](/docs/cloud/builder-and-guard) |
| Test Cells without deploying | [Testing Cells](/docs/cloud/testing-cells) |
| Preview a deployment on AWS | [AWS preview](/docs/cloud/aws-preview) |
| Check what Cloud can't do yet | [Cloud status and limits](/docs/cloud/status-and-limits) |

## Every page, by product

### Anvil Desktop

- [Overview](/docs/desktop/overview)
- [Architecture](/docs/desktop/architecture)
- [Operating guide](/docs/desktop/operating-guide)
- [Agent workflows](/docs/desktop/agent-workflows)
- [Chat, personas and models](/docs/desktop/chat-personas-and-llm)
- [Git workflows](/docs/desktop/git-workflows)
- [Work items and planning](/docs/desktop/work-items-and-planning)
- [Security and review](/docs/desktop/security-and-review)
- [Data, governance and evidence](/docs/desktop/data-governance-evidence)
- [Companion surfaces](/docs/desktop/companion-surfaces)
- [Terminal and editor](/docs/desktop/terminal-and-editor)
- [Automations](/docs/desktop/automations)
- [User-definable software factories](/docs/desktop/software-factories)
- [Database guide](/docs/desktop/database-guide)
- [Extending Anvil Desktop](/docs/desktop/extending-anvil)
- [Build and release](/docs/desktop/build-and-release)
- [Sync and Mesh settings](/docs/desktop/sync-and-mesh)

### Sync & Mesh

- [Sync & Mesh overview](/docs/sync/overview)
- [LAN-first Mesh routes](/docs/sync/lan-first-routes)
- [Run your own backend](/docs/sync/self-deploy)

### Anvil Registry

- [Introduction](/docs/registry/introduction)
- [Alpha status](/docs/registry/alpha-status)
- [Quickstart](/docs/registry/quickstart)
- [Architecture](/docs/registry/architecture)
- [Policy](/docs/registry/policy)
- [Package decisions](/docs/registry/package-decisions)
- [Worker analysis](/docs/registry/worker-analysis)
- [Registry configuration](/docs/registry/registry-configuration)
- [Registry seeding](/docs/registry/registry-seeding)
- [CLI](/docs/registry/cli)
- [CI](/docs/registry/ci)
- [Deploy](/docs/registry/deploy)
- [API reference](/docs/registry/api-reference)
- [LLM integration](/docs/registry/llm-integration)
- [Security](/docs/registry/security)
- [Contributing](/docs/registry/contributing)
- [Troubleshooting](/docs/registry/troubleshooting)
- [Rollout guide](/docs/registry/rollout-guide)

### Anvil Node Base

- [Overview](/docs/node-base/overview)
- [Safe mode](/docs/node-base/safe-mode)
- [Observed mode](/docs/node-base/observed-mode)
- [Reports](/docs/node-base/reports)
- [Network policy](/docs/node-base/network-policy)

### Anvil Cloud

- [Overview](/docs/cloud/overview)
- [Quickstart](/docs/cloud/quickstart)
- [Examples](/docs/cloud/examples)
- [Cell contract](/docs/cloud/cell-contract)
- [Anvil Agents](/docs/cloud/agents)
- [Agent Sandboxes](/docs/cloud/agent-sandboxes)
- [Auth](/docs/cloud/auth)
- [Workflows](/docs/cloud/workflows)
- [Services](/docs/cloud/services)
- [Endpoints and jobs](/docs/cloud/endpoints-and-jobs)
- [Runtime model](/docs/cloud/architecture)
- [Local runtime](/docs/cloud/local-runtime)
- [Anvil Lens](/docs/cloud/lens)
- [Builder and Guard](/docs/cloud/builder-and-guard)
- [Testing Cells](/docs/cloud/testing-cells)
- [CLI reference](/docs/cloud/cli-reference)
- [Generated client](/docs/cloud/generated-client)
- [AWS preview](/docs/cloud/aws-preview)
- [Status and limits](/docs/cloud/status-and-limits)

## What Anvil won't claim

Agents, LLMs, package heuristics and runtime abstractions don't replace human judgement, and nothing here says they do. Anvil's job is narrower: to help you see what the work actually did before you trust it.
