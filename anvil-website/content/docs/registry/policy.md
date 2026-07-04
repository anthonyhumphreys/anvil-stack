---
title: Policy model
navTitle: Policy
description: How Anvil Registry decides whether a package should be allowed, warned, quarantined, or blocked.
product: Anvil Registry
section: Concepts
order: 4
---

# Policy model

Anvil Registry policy is deterministic. It combines metadata, analysis reports, provenance context, package popularity, and audited overrides into a single decision.

The policy engine is the authority. LLM review may add structured context or reviewer notes, but it cannot be the sole reason a package is allowed.

## Decision actions

| Action | Meaning |
| --- | --- |
| `allow` | Install can continue. |
| `warn` | Development can proceed, but reviewers should inspect the signal. |
| `quarantine` | The package is held unless the runtime mode permits it or an override exists. |
| `block` | Install is denied. |

## Runtime modes

Policy can be applied differently depending on where Anvil Registry is running:

| Mode | Typical behaviour |
| --- | --- |
| Development | Warn or quarantine unknown packages so developers can inspect findings without turning every trial install into a wall. |
| CI | Fail closed for high-confidence risk and unknown packages that require review. |
| Production | Prefer known, reviewed, cached, immutable package identities. |

The exact thresholds belong in policy configuration, but the shape is simple: developer feedback can be softer; CI and production gates should be stricter.

## Signals

Anvil Registry can detect:

- New or changed lifecycle scripts.
- Runtime, optional, peer, and development dependency changes.
- New dependencies in patch versions.
- Repository, license, maintainer, `bin`, and `files` metadata changes.
- Unexpected binaries, executable files, hidden files, unusual paths, and credential-looking files.
- Name-squatting and typo-squatting risk.
- Missing, removed, changed, or mismatched provenance.
- LLM-flagged high-risk review context.

## Metadata checks

Metadata checks are cheap and run before deeper analysis:

- Package age.
- Dist-tag target.
- Known overrides or revocations.
- Known blocked package names or versions.
- Adoption and download signals.
- Provenance availability when package volume makes that signal meaningful.
- Scoped registry routing and upstream registry identity.

Cheap checks keep the install path fast while still catching obvious problems.

## Static analysis checks

Static analysis happens outside the request path where possible. It can compare the target version against prior releases and flag:

- New lifecycle scripts.
- Changed lifecycle scripts.
- Dependency additions in patch versions.
- Manifest, maintainer, repository, license, `bin`, and `files` changes.
- Encoded blobs, suspicious binaries, executable files, hidden files, unusual paths, and credential-looking files.
- Install-path code patterns such as shell piping, dynamic execution, or network fetches.

Unknown or suspicious packages can be allowed, warned, quarantined, or blocked depending on the current policy mode.

## Immutable cache identity

Policy decisions and analysis reports are cached by:

- Package name.
- Version.
- Tarball integrity or hash.
- Analysis engine version.
- Policy version.

If the tarball or analyser changes, the cached decision no longer silently applies to a different artifact.

## Overrides

Overrides are explicit and audited:

```bash
anvil registry approve suspicious-pkg@1.2.3 --reason "internal fork, reviewed by security"
```

Package-wide overrides are possible, but version-specific overrides are easier to reason about and safer to expire.

Good override reasons name the evidence reviewed, the approving person or team, and the expected expiry or follow-up. "Build was red" is not a security review; it is an operational symptom.

## Decision output

Machine-readable decisions should include:

- Package name and version.
- Immutable tarball identity.
- Decision action.
- Policy version.
- Analysis engine version.
- Triggering signals.
- Override status, reason, and expiry if present.
- Human-readable explanation for developers.

That output should be useful both in a terminal and in CI logs.
