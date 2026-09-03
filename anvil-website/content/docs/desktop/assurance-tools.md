---
title: Assurance tools
navTitle: Assurance tools
description: Code review, security audits, dynamic pentests, dependency checks, database analysis, and compliance drafts in Anvil Desktop.
product: Anvil Desktop
section: Assurance
journey: reference
order: 118
---

# Assurance tools

Anvil Desktop has several evidence-producing review tools. They overlap on purpose, but they answer different questions. None of them replaces tests, a specialist review, or a deterministic production control.

## Code Review

Code Review can inspect a full codebase, commit, branch, or pull request in quick-glance or deeper senior-review mode. A review stores its findings and repository change summary.

For each finding you can draft a fix prompt, dismiss it, create a work item, or post it to the linked pull request. Bulk actions support fix prompts and work-item creation. The review or its findings can also be exported.

Pull request support includes listing provider pull requests, reading a pull request diff, posting comments, and generating a persisted visualisation of the change. Exported visualisations are review aids, not a substitute for reading the diff.

## Security audits

Security audits inspect an indexed repository and report progress while the configured model analyses the code. Findings can be dismissed, turned into work items individually or in bulk, and exported as a report.

The useful unit is a finding with a file, risk, reason, suggested action, and verification status. An OWASP or CWE label on its own proves very little.

## Dynamic pentests

The Pentest tab starts Docker-backed scans with an explicit scan configuration. It checks Docker availability before launch, streams scan events, stores runs and findings, and supports stop, dismissal, work-item creation, bulk work-item creation, and report export.

Dynamic scanning can execute tools against running software and network targets. Confirm the target and authorization before starting. Stopping a scan ends the current run but cannot undo traffic already sent.

## Dependencies, licences, and SBOMs

The Dependencies view reads package manifests for npm, pnpm, Yarn, NuGet, and Python projects. It lists package version, manager, licence metadata, and deprecation signals.

You can run the selected manager's audit command, audit installed licence metadata, and export a software bill of materials as CycloneDX JSON, SPDX JSON, or CSV. Audit output is displayed for triage, including the command and exit code.

This is local evidence. Use [Anvil Registry](/docs/registry/introduction) when an organisation needs deterministic package-ingress policy, cached package identity, quarantine, or audited overrides.

## DB Insights

DB Insights imports database export files into the active workspace and analyses them together. The result covers:

- tables and notable columns
- stored procedures and referenced objects
- explicit relationships
- risks and watchpoints
- follow-up questions that can be opened in Chat

The analyser works from the exports you add. Missing schema, routines, or production-only behavior will remain missing from its answer. Remove an imported artifact when it should no longer be part of the workspace evidence.

## Data and Compliance

Data and Compliance analyses an indexed repository and can generate three document types:

- a UK GDPR-oriented data protection impact assessment
- a privacy policy draft
- a terms of service draft

The generated Markdown is saved under `docs/` in the repository and shown in Anvil for review. Regeneration replaces the generated draft for that document type.

These files contain `[ACTION REQUIRED]` markers where code cannot supply the answer. They are starting points, not legal advice. A qualified legal or data-protection reviewer must check the final text.

## Choosing the right tool

| Question | Start here |
| --- | --- |
| Is this change correct and reviewable? | Code Review |
| Does the source expose an implementation security risk? | Security |
| How does a running target respond to security probes? | Pentest |
| What package, licence, or SBOM risk exists? | Dependencies |
| What does this database export imply? | DB Insights |
| Which privacy or legal questions does the code leave unanswered? | Data and Compliance |

Record the exact scope and date with exported evidence. A clean result against the wrong branch is still the wrong result.
