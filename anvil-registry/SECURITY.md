# Security Policy

Anvil Registry is an open source security-focused project for the Node/npm ecosystem. It includes an npm registry gateway, package analysis tooling, policy enforcement, an admin surface, a CLI, and a hardened Node devcontainer base image.

Security reports are welcome and will be handled with care. Please do not disclose exploitable issues publicly until a fix or mitigation is available.

## Supported Versions

This project is pre-1.0. Security fixes are made on `main` unless a maintained release branch is documented here.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest published release | Best effort |
| Older releases, commits, or forks | No |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately.

Preferred reporting method:

- Use GitHub private vulnerability reporting or open a GitHub Security Advisory for this repository.

If private vulnerability reporting is not available, contact the maintainer privately before opening a public issue. Do not include working exploit details, secrets, private package data, or other sensitive material in a public issue.

Please include as much of the following as possible:

- Affected component: gateway, worker, admin, CLI, Node Base image, infrastructure, or documentation.
- Affected version, commit, image tag, or deployment configuration.
- Steps to reproduce or a minimal proof of concept.
- Expected impact and likely attacker capabilities.
- Relevant logs, request examples, package names, tarball hashes, policy output, or report snippets.
- Whether the issue affects private registries, scoped package routing, install scripts, admin actions, overrides, CI enforcement, or secrets.

Please do not include real secrets, customer data, private package source, or private registry tokens in reports. Use redacted examples whenever possible.

## Pull Requests

Pull requests are accepted.

Security hardening PRs are welcome, especially when they include tests or a clear reproduction case. For vulnerabilities with exploitable impact, please report privately first so maintainers can coordinate a fix without exposing users.

All changes should be made through pull requests. The `main` branch is protected and should require passing checks before merge.

## What To Report

Useful security reports include, but are not limited to:

- npm metadata or tarball requests bypassing Anvil policy.
- Scoped package traffic leaking around the gateway.
- Tarball URL rewriting failures that send clients back to an upstream registry.
- Policy decision cache confusion across package versions, tarball hashes, analyser versions, or policy versions.
- Incorrect allow decisions for packages that should be blocked or quarantined by deterministic policy.
- Override, admin-token, or report-submission bypasses.
- Node Base behaviour that executes lifecycle scripts without explicit opt-in.
- Observed-mode report gaps that hide process, filesystem, or network activity.
- Secret leakage through logs, reports, readiness output, admin views, CLI output, or generated artifacts.
- Unsafe handling of private registry tokens or scoped upstream credentials.
- SSRF, path traversal, archive extraction, command execution, deserialization, or dependency confusion issues.
- CI or production-mode behaviour that fails open where policy enforcement should fail closed.

## Out Of Scope

The following are usually out of scope unless they create a concrete exploit path:

- Denial-of-service against a local development stack without a realistic production path.
- Reports requiring already-compromised maintainer credentials.
- Missing full authentication where the documented surface is intentionally local-only or token-gated.
- Package ecosystem risk that Anvil correctly reports, quarantines, or blocks.
- Social engineering, spam, or physical attacks.
- Automated scanner output without a reachable vulnerability or demonstrated impact.

## Disclosure Process

Maintainers will aim to:

1. Acknowledge the report within 7 days.
2. Confirm the affected components and security impact.
3. Prepare a fix, mitigation, or documentation correction.
4. Coordinate disclosure timing with the reporter where appropriate.
5. Publish an advisory when users need to take action.

Security fixes may be merged privately or through a public pull request depending on impact. Public disclosure should wait until affected users have a reasonable path to update or mitigate.

## Safe Research Guidelines

Good-faith security research is welcome. Please:

- Test only against systems, packages, and registries you control or have permission to assess.
- Do not access, modify, delete, or exfiltrate data that is not yours.
- Do not submit real secrets, private package contents, private registry metadata, or customer data.
- Do not run lifecycle scripts against systems you do not control.
- Do not degrade public npm, private registries, hosted deployments, or other users' CI.
- Stop testing and report privately once you have enough evidence to demonstrate the issue.

## Security Design Expectations

Anvil's enforcement model is deterministic policy first:

- LLM review may add structured context, but must not be the sole reason a package is allowed.
- Policy and analysis decisions must be cached by immutable package identity, including tarball integrity or hash.
- Lifecycle scripts should not execute unless explicitly approved.
- Private package source must not be sent to an LLM unless explicitly enabled.
- CI and production modes should fail closed where policy enforcement matters.

Reports about implementation drift from these expectations are welcome.
