---
title: Node Base observed mode
navTitle: Observed mode
description: Run install scripts explicitly while capturing process, network, filesystem, and environment evidence.
product: Anvil Node Base
section: Guides
journey: build
order: 8
---

# Node Base observed mode

Observed mode is for packages that require lifecycle scripts. It enables scripts, watches what happens, and writes evidence.

```bash
anvil-npm-ci-observed
```

Observed mode is explicit because install scripts are code execution. This is the mode for "we need to run it, but we are not closing our eyes."

## What it captures

Observed mode writes:

| File | Purpose |
| --- | --- |
| `npm-install.log` | npm output with foreground lifecycle scripts. |
| `strace.log` | Process, file, and network syscall trace. |
| `lifecycle-scripts.json` | Packages with install, preinstall, postinstall, or prepare scripts. |
| `ioc-report.json` | Machine-readable IOC summary. |
| `ioc-report.md` | Human-readable IOC report. |
| `environment-snapshot.json` | Environment snapshot with credential-looking values redacted. |

## Network monitoring

Observed mode flags:

- Direct IP connections.
- Non-standard ports.
- Suspicious generated-looking domains.
- Blocked hosts.
- Connections made during install scripts.

You can tune network policy with environment variables for allowed ports, allowed hosts, blocked hosts, and severity levels.

## Process and filesystem monitoring

Observed mode also looks for:

- Shell piping into `bash` or `sh`.
- `child_process` use.
- Dynamic code execution.
- `chmod +x` followed by execution.
- Background process tricks.
- Attempts to read credential-looking files such as `.npmrc`, `.env`, `.ssh`, cloud configs, or Git credentials.

## Strict observed mode

Fail on high-confidence IOC findings:

```bash
ANVIL_STRICT=true ANVIL_STRICT_RISK_LEVEL=high anvil-npm-ci-observed
```

Fail on medium or high findings:

```bash
ANVIL_STRICT=true ANVIL_STRICT_RISK_LEVEL=medium anvil-npm-ci-observed
```

Use medium-level strictness when reviewing unknown repos or sensitive CI jobs.

## Use with Anvil Registry

Observed mode reports can be submitted to Anvil Registry/Admin so reviewers see install-time evidence alongside registry decisions:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
ANVIL_PROJECT_NAME=my-project \
  anvil-npm-ci-observed
```

Use project names that match the repo or CI job. Future you will appreciate the breadcrumb. Future you is already tired.
