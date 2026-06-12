---
title: Anvil Node Base
navTitle: Overview
description: Use the hardened Node base image for safer local and CI dependency installs.
product: Anvil Node Base
section: Concepts
order: 6
---

# Anvil Node Base

Anvil Node Base is a local safety harness. It is not a registry replacement.

Use it for:

- Devcontainers.
- CI containers.
- Agentic coding sandboxes.
- Unknown repo inspection.
- Pull request dependency review.

## What it changes

The image is built around safer npm defaults:

| Setting | Default |
| --- | --- |
| User | Non-root `node` user |
| npm install scripts | `ignore-scripts=true` |
| npm script output | `foreground-scripts=true` |
| npm funding prompts | `fund=false` |
| Lockfile behaviour | `package-lock=true` and `save-exact=true` |
| Report location | `.anvil/reports` or `ANVIL_REPORT_DIR` |

The default mode is intentionally conservative. If a package needs install scripts, switch to observed mode rather than silently weakening the base image.

## Safe mode

```bash
anvil-npm-ci-safe
```

Safe mode runs:

```bash
npm ci --ignore-scripts
```

Then it scans `node_modules` package manifests for lifecycle scripts and writes a report under `.anvil/reports` or `ANVIL_REPORT_DIR`.

Use safe mode when:

- You are doing routine CI installs.
- You are opening an unknown repository for the first time.
- You want to know which packages attempted lifecycle scripts without running them.
- You want a low-noise report for pull request review.

## Observed mode

```bash
anvil-npm-ci-observed
```

Observed mode explicitly allows install scripts, wraps the install with syscall monitoring, and writes:

- `npm-install.log`
- `strace.log`
- `lifecycle-scripts.json`
- `ioc-report.json`
- `ioc-report.md`
- `environment-snapshot.json`

Sensitive environment variable values are redacted in the snapshot.

Use observed mode when:

- A dependency genuinely requires lifecycle scripts.
- You are reviewing why a package needs install-time execution.
- You want evidence for outbound connections, child processes, or sensitive file access.
- You are debugging a dependency that behaves differently under `--ignore-scripts`.

Observed mode is intentionally explicit. It is the "fine, but we are watching" mode.

## Registry integration

```bash
anvil-use-registry http://localhost:4873
```

This writes project npm config so scoped and unscoped package traffic routes through Anvil Registry. Scoped registry overrides are removed by default so scoped package installs do not quietly bypass policy.

## Strict mode

Strict mode turns reports into exit gates:

```bash
ANVIL_STRICT=true anvil-npm-ci-safe
ANVIL_STRICT=true anvil-npm-ci-observed
```

Useful settings:

| Variable | Values | Purpose |
| --- | --- | --- |
| `ANVIL_STRICT` | `true` or `false` | Enables report-based failure. |
| `ANVIL_STRICT_RISK_LEVEL` | `high`, `medium`, `off` | Controls which IOC severity fails. |
| `ANVIL_STRICT_LIFECYCLE_MODE` | `any`, `risk`, `off` | Controls lifecycle-script failure behaviour. |

Use stricter settings in CI than in exploratory local work.

## Report submission

Reports can be submitted to Anvil Registry/Admin when configured:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
ANVIL_PROJECT_NAME=my-project \
  anvil-submit-report .anvil/reports/ioc-report.json ioc
```

Use report submission when reviewers need to see Node Base findings alongside registry decisions.
