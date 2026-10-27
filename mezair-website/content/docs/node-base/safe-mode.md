---
title: Node Base safe mode
navTitle: Safe mode
description: Install dependencies without lifecycle scripts and generate reviewable dependency reports.
product: Mezair Node Base
section: Guides
journey: build
order: 20
---

# Node Base safe mode

Safe mode is the default Mezair Node Base workflow. It installs dependencies without running lifecycle scripts and then reports which packages wanted install-time execution.

```bash
mezair-npm-ci-safe
```

Under the hood, safe mode runs:

```bash
npm ci --ignore-scripts
```

## What safe mode writes

Reports are written to `.mezair/reports` by default. Override the location with:

```bash
MEZAIR_REPORT_DIR=/tmp/mezair-reports mezair-npm-ci-safe
```

Safe mode writes `lifecycle-scripts.json`. Depending on the workflow, you can also run:

```bash
mezair-dep-report
```

That generates dependency reports from an existing `node_modules` tree without reinstalling.

## When safe mode should pass

Safe mode should pass when:

- `npm ci --ignore-scripts` succeeds.
- Reports are generated.
- Strict mode is disabled, or strict mode finds no configured failure condition.

If packages contain lifecycle scripts, safe mode can still succeed unless strict mode says otherwise. The report is the point: it makes install-time execution visible without running it.

## Strict safe mode

To fail when lifecycle scripts are present:

```bash
MEZAIR_STRICT=true MEZAIR_STRICT_LIFECYCLE_MODE=any mezair-npm-ci-safe
```

To fail only when lifecycle-script findings are risky:

```bash
MEZAIR_STRICT=true MEZAIR_STRICT_LIFECYCLE_MODE=risk mezair-npm-ci-safe
```

Use `any` for high-control environments and `risk` when you need fewer false positives.

## Pull request review

Safe mode works well for dependency bump pull requests:

1. Run `mezair-npm-ci-safe`.
2. Upload `.mezair/reports` as CI artifacts.
3. Review packages with lifecycle scripts.
4. Use Mezair Registry explain output for package decisions.
5. Switch to observed mode only for packages that genuinely require scripts.
