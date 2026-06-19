# Security Policy

Anvil is an alpha-stage open source project. Security reports are welcome, and
we ask that exploitable issues are reported privately before public discussion.

## Supported Scope

This policy covers the Anvil Stack monorepo:

- `anvil-app/`: the Electron desktop app, mobile companion, video project, and
  Raycast extension.
- `anvil-cloud/`: the Cloud runtime, CLI, SDK packages, local runtime, and
  deployment adapters.
- `anvil-registry/`: the npm registry gateway, package analysis pipeline,
  policy engine, admin app, CLI, infrastructure, and Node Base image.
- `anvil-website/`: the public website and documentation.

The project is still moving quickly, so supported versions are generally the
current `main` branch and the latest published release artifacts for each
product. If you are reporting an issue against an older release, include the
exact tag, package version, container digest, or commit SHA. We will assess
whether a backport is practical.

## Reporting A Vulnerability

Please do not open a public GitHub issue for a vulnerability with exploitable
impact.

Use GitHub's private vulnerability reporting or security advisory flow for this
repository. If that is not available, contact the maintainer privately through
GitHub and ask for a secure reporting channel.

Include as much of the following as you can:

- The affected project, package, image, CLI command, route, or release artifact.
- The version, tag, commit SHA, or container digest tested.
- A clear description of the impact.
- Steps to reproduce, preferably with a minimal proof of concept.
- Any relevant logs, request/response samples, dependency versions, or policy
  configuration.
- Whether the issue is already public or known to be exploited.

Please avoid sending secrets, production customer data, private package source,
or large exploit payloads unless a maintainer explicitly asks for them through a
secure channel.

## What To Expect

We aim to acknowledge valid private reports within 7 days. Response times may
vary because this is an early open source project rather than a staffed security
desk, glamorous as that would be.

For confirmed vulnerabilities, we will try to:

- Reproduce and assess the report.
- Identify the affected products, versions, and deployment modes.
- Fix or mitigate the issue in the smallest safe change.
- Publish release notes or an advisory when disclosure is appropriate.
- Credit reporters when requested and when doing so is safe.

If a report is out of scope, already known, or not exploitable as described, we
will say so plainly.

## Coordinated Disclosure

Please give us a reasonable opportunity to investigate and ship a fix before
publishing details. A typical disclosure window is 90 days, but we can agree a
different timeline depending on severity, exploitability, and whether the issue
is already public.

## Security Boundaries

The Anvil projects include security-sensitive systems, especially the registry
gateway, dependency policy engine, package analysis pipeline, generated clients,
auth handling, deployment adapters, and local developer tooling. Useful reports
include, but are not limited to:

- Authentication or authorization bypasses.
- Secret exposure in logs, diagnostics, reports, readiness output, or packaged
  artifacts.
- Unsafe package installation, lifecycle script execution, or policy bypasses.
- Dependency confusion, package identity, provenance, or registry routing bugs.
- Remote code execution, command injection, path traversal, or SSRF.
- Cross-site scripting or request forgery in web/admin surfaces.
- Sandbox, build, or deployment escape paths.
- Supply-chain risks in published packages, containers, or release workflows.

General hardening ideas are welcome as public issues or pull requests when they
do not disclose an active vulnerability. For exploitable bugs, use private
reporting first. Public proof-of-concept fireworks can wait; production cannot.
