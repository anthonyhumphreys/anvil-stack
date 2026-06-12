---
title: Node Base reports
navTitle: Reports
description: Understand report files, strict-mode gates, network reports, and report submission.
product: Anvil Node Base
section: Guides
order: 9
---

# Node Base reports

Anvil Node Base reports are designed for humans and automation. JSON files drive gates and dashboards; Markdown files help reviewers read the evidence without spelunking through raw logs.

## Report directory

Reports go to:

```text
.anvil/reports
```

Override the directory with:

```bash
ANVIL_REPORT_DIR=/tmp/anvil-reports anvil-dep-report
```

## Dependency report

Generate a report from an existing install:

```bash
anvil-dep-report
```

This scans `node_modules`, lifecycle scripts, package metadata, and package-name signals where registry data is available.

## Network monitor

Run any command with network syscall monitoring:

```bash
anvil-network-monitor -- npm test
```

This writes:

- `network-strace.log`
- `network-report.json`
- `network-report.md`

Use this for commands other than dependency installation when you still want outbound connection evidence.

## Risk gate

Apply strict-mode policy to a report:

```bash
ANVIL_STRICT=true anvil-risk-gate .anvil/reports/ioc-report.json ioc
```

Report types:

| Type | Use |
| --- | --- |
| `lifecycle` | Lifecycle-script report from safe mode. |
| `dependency` | Dependency report from `anvil-dep-report`. |
| `ioc` | Observed install IOC report. |
| `network` | Network monitor report. |

## Submitting reports

Submit reports to Anvil Registry/Admin:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
ANVIL_PROJECT_NAME=my-project \
ANVIL_REPORT_SOURCE=ci \
  anvil-submit-report .anvil/reports/network-report.json network
```

Submission lets teams review Node Base findings in the same place they review registry decisions and overrides.

## Redaction

Environment snapshots redact values for variable names that look credential-bearing, such as:

- `TOKEN`
- `SECRET`
- `PASSWORD`
- `PRIVATE`
- `CREDENTIAL`
- `AUTH`
- `COOKIE`
- `SESSION`
- `DATABASE_URL`
- `KEY`

Do not treat redaction as permission to dump secrets into logs. Redaction reduces damage; it does not make bad hygiene holy.
