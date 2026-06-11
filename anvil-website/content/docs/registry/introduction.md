---
title: Introduction
description: What Anvil Registry is, who it is for, and how the pieces fit together.
product: Anvil Registry
section: Getting started
order: 1
---

# Introduction

Anvil Registry and Anvil Node Base are open source dependency safety tools for the Node and npm ecosystem.

They solve related problems at different points in the install path:

- **Anvil Registry** sits between npm-compatible clients and upstream registries. It proxies metadata and tarballs, rewrites tarball URLs through itself, caches artifacts, evaluates policy, queues deeper analysis, and records package decisions before installs reach developers or CI.
- **Anvil Node Base** is a hardened Node devcontainer base image. It defaults npm toward safer installs, provides explicit safe and observed install modes, and writes local security reports when you need to inspect an unfamiliar project.

The goal is practical dependency review. These tools do not ask teams to stop using npm clients, rewrite package managers, or trust a black box. They put policy and evidence where dependency risk actually enters the workflow.

## Why it exists

Most teams discover dependency risk after the install has already happened. That is backwards.

Anvil Registry moves the decision earlier:

1. Fetch package metadata through a controlled gateway.
2. Evaluate cheap metadata policy immediately.
3. Queue deeper analysis outside the request path.
4. Cache analysis and policy decisions by immutable tarball identity.
5. Return clear block, quarantine, or allow explanations.

## Design principles

- Deterministic policy is the enforcement authority.
- LLM review can explain risk, but it cannot allow a package by itself.
- CI and production should fail closed where it matters.
- Overrides must be explicit, reasoned, audited, and preferably expiring.
- Install scripts should not execute unless someone intentionally opted into them.

## When to use each tool

| Situation | Use |
| --- | --- |
| You want all npm, pnpm, or yarn traffic to pass through a controlled policy gateway. | Anvil Registry |
| You want package metadata and tarball requests cached and audited. | Anvil Registry |
| You want CI to reject, quarantine, or explain risky dependency versions. | Anvil Registry |
| You are inspecting an unknown repository locally. | Anvil Node Base |
| You need `npm ci --ignore-scripts` by default, with a report of packages that wanted lifecycle scripts. | Anvil Node Base |
| You need to run lifecycle scripts, but capture process, file, and network evidence while doing it. | Anvil Node Base observed mode |

## Core components

| Component | Role |
| --- | --- |
| Gateway | npm-compatible metadata and tarball proxy |
| Worker | Static analysis, name-squatting checks, provenance context, LLM review |
| Admin | Human review, decisions, reports, overrides, policy visibility |
| CLI | Explain decisions, scan lockfiles, request analysis, manage overrides |
| Node Base | Safer local and CI container for dependency installation |
