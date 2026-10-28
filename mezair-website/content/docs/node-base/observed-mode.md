---
title: Node Base observed mode
navTitle: Observed mode
description: Run install scripts explicitly while capturing process, network, filesystem, and environment evidence.
product: Mezair Node Base
section: Guides
journey: build
order: 30
---

# Node Base observed mode

Observed mode is for packages that require lifecycle scripts. It enables scripts, watches what happens, and writes evidence.

```bash
mezair-npm-ci-observed
```

Choose observed mode only when you need lifecycle scripts to run. It records their activity for review; it does not make those scripts safe.

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
MEZAIR_STRICT=true MEZAIR_STRICT_RISK_LEVEL=high mezair-npm-ci-observed
```

Fail on medium or high findings:

```bash
MEZAIR_STRICT=true MEZAIR_STRICT_RISK_LEVEL=medium mezair-npm-ci-observed
```

Use medium-level strictness when reviewing unknown repos or sensitive CI jobs.

## Use with Mezair Registry

Observed mode reports can be submitted to Mezair Registry/Admin so reviewers see install-time evidence alongside registry decisions:

```bash
MEZAIR_REGISTRY_URL=http://localhost:4873 \
MEZAIR_ADMIN_TOKEN=local-dev-token \
MEZAIR_PROJECT_NAME=my-project \
  mezair-npm-ci-observed
```

Use the repository or CI job name so reviewers can identify where the report came from.
