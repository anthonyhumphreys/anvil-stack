---
title: Anvil docs
navTitle: Overview
description: Start here for Anvil Desktop, Anvil Registry, Anvil Node Base, and Anvil Cloud.
product: Start here
section: Welcome
order: 10
---

# Anvil docs

Anvil is an open source family of developer tools for work that needs evidence before trust.

The public site covers three main repositories:

- **anvil-app**: Anvil Desktop, a local Electron workspace for repo-aware agent delivery, work items, review, security checks, terminals, documentation, diagrams, companion controls, and handover evidence.
- **anvil-registry**: Anvil Registry plus Anvil Node Base, a TypeScript npm gateway and hardened Node devcontainer image for policy, package analysis, cache identity, safer installs, reports, and explicit overrides.
- **anvil-cloud**: Anvil Cloud, a local-first TypeScript platform for Anvil Cells, shared runtime contracts, builder output, local inspection, generated clients, and adapter-driven deployment.

The tools are separate because they own different risk boundaries. Desktop owns local delivery context. Registry owns dependency ingress. Cloud owns the app runtime contract. Node Base owns install execution inside a safer container.

## Start by job

| Job | Start here |
| --- | --- |
| Understand the monorepo layout | [Monorepo map](/docs/project/repositories) |
| Understand the desktop app | [Desktop overview](/docs/desktop/overview) |
| Follow Electron process boundaries | [Desktop architecture](/docs/desktop/architecture) |
| Run repo-aware agent sessions | [Agent workflows](/docs/desktop/agent-workflows) |
| Configure LLM providers and personas | [Chat personas and LLM](/docs/desktop/chat-personas-and-llm) |
| Manage Git branches and commits | [Git workflows](/docs/desktop/git-workflows) |
| Review security and code changes | [Security and review](/docs/desktop/security-and-review) |
| Use phone, watch, Raycast, widgets, or menu bar controls | [Companion surfaces](/docs/desktop/companion-surfaces) |
| Try the registry gateway locally | [Registry quickstart](/docs/registry/quickstart) |
| Understand dependency decisions | [Package decisions](/docs/registry/package-decisions) |
| Understand what analysis detects | [Worker analysis](/docs/registry/worker-analysis) |
| Roll out the registry safely | [Registry rollout guide](/docs/registry/rollout-guide) |
| Contribute to Registry or Node Base | [Contributing to Anvil Registry](/docs/registry/contributing) |
| Use the hardened Node image | [Node Base overview](/docs/node-base/overview) |
| Build an Anvil Cell | [Cloud quickstart](/docs/cloud/quickstart) |
| Understand the Cell contract | [Cloud Cell contract](/docs/cloud/cell-contract) |
| Add authentication to a Cell | [Cloud auth](/docs/cloud/auth) |
| Run durable multi-step workflows | [Cloud workflows](/docs/cloud/workflows) |
| Run long-lived supervised services | [Cloud services](/docs/cloud/services) |
| Manage a Cell from a local UI | [Anvil Lens](/docs/cloud/lens) |
| Understand local runtime and inspection | [Cloud local runtime](/docs/cloud/local-runtime) |
| Understand builder and Guard checks | [Cloud builder and Guard](/docs/cloud/builder-and-guard) |
| Test Cells without deploying | [Testing Cells](/docs/cloud/testing-cells) |
| Preview deployment through AWS | [Cloud AWS preview](/docs/cloud/aws-preview) |
| Check current Cloud limits | [Cloud status and limits](/docs/cloud/status-and-limits) |

## Read by product

### Anvil Desktop

Read these when you want to understand the desktop app as a local delivery workspace:

- [Overview](/docs/desktop/overview)
- [Architecture](/docs/desktop/architecture)
- [Operating guide](/docs/desktop/operating-guide)
- [Agent workflows](/docs/desktop/agent-workflows)
- [Chat personas and LLM providers](/docs/desktop/chat-personas-and-llm)
- [Git workflows](/docs/desktop/git-workflows)
- [Work items and planning](/docs/desktop/work-items-and-planning)
- [Security and review](/docs/desktop/security-and-review)
- [Data, governance, and evidence](/docs/desktop/data-governance-evidence)
- [Companion surfaces](/docs/desktop/companion-surfaces)
- [Terminal and editor](/docs/desktop/terminal-and-editor)
- [Automations](/docs/desktop/automations)
- [Database guide](/docs/desktop/database-guide)
- [Extending Anvil Desktop](/docs/desktop/extending-anvil)
- [Build and release](/docs/desktop/build-and-release)

### Anvil Registry

Read these when you want package policy, npm gateway behavior, or Node Base install safety:

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

Read these when install execution is the risk:

- [Overview](/docs/node-base/overview)
- [Safe mode](/docs/node-base/safe-mode)
- [Observed mode](/docs/node-base/observed-mode)
- [Reports](/docs/node-base/reports)
- [Network policy](/docs/node-base/network-policy)

### Anvil Cloud

Read these when you want the alpha app contract and adapter path:

- [Overview](/docs/cloud/overview)
- [Quickstart](/docs/cloud/quickstart)
- [Examples](/docs/cloud/examples)
- [Cell contract](/docs/cloud/cell-contract)
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

## What Anvil is not

Anvil is not a SaaS dashboard pretending to be local tooling. It is not a security vendor landing page with twelve synonyms for visibility. It is also not a claim that agents, LLMs, package heuristics, or runtime abstractions remove the need for human judgement.

The useful claim is smaller and sharper: Anvil helps developers inspect the work before trusting it.
