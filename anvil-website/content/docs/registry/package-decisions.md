---
title: Package decisions
navTitle: Package decisions
description: Interpret allow, warn, quarantine, block, explain, analysis, LLM review, and override output.
product: Anvil Registry
section: Concepts
order: 5
---

# Package decisions

Anvil Registry turns package evidence into a decision. The useful part is not just the final action; it is the reason a reviewer can inspect later.

## Decision lifecycle

1. Package metadata is fetched and cached.
2. Cheap policy checks run immediately.
3. Existing decisions are reused only when the immutable cache identity matches.
4. Unknown or suspicious packages are queued for worker analysis.
5. Optional LLM review adds structured context.
6. Policy emits `allow`, `warn`, `quarantine`, or `block`.
7. Overrides can explicitly change the outcome with an audit trail.

## Explain output

Use explain before approving a dependency bump:

```bash
anvil explain left-pad@1.3.0
```

Useful explain output includes:

- Current decision.
- Policy version.
- Package age and adoption signals.
- Provenance state.
- Static-analysis findings.
- Name-squatting signals.
- LLM review context when enabled.
- Override state.

## Quarantine

Quarantine means the package is not necessarily malicious, but it needs review before it should land in stricter environments.

Common quarantine reasons:

- Newly published version.
- Low adoption plus name similarity to a popular package.
- New lifecycle script in a patch release.
- Missing provenance on a package where provenance is expected.
- Static-analysis finding that needs human context.

## Block

Block is for high-confidence policy failures:

- Known malicious package or version.
- High-confidence install-script IOC.
- Dangerous lifecycle-script change in a sensitive mode.
- Revoked override.
- Tarball identity mismatch.

Blocked responses should be clear enough for a developer to know whether they need to change a dependency, wait for analysis, or ask for review.

## LLM review

LLM review can be useful for summarizing messy evidence:

- Why a lifecycle-script change looks suspicious.
- Which files are worth opening first.
- Whether a package resembles a typo-squat.
- What a reviewer should verify manually.

LLM review is not the enforcement authority. It can recommend caution; it cannot make an unsafe package safe by sounding confident. We already have enough software that does that.

## Overrides

Use overrides when a human reviewer has inspected the evidence and wants to change the outcome:

```bash
anvil approve @internal/build-tool@2.4.1 --reason "internal package, reviewed by platform security"
```

Prefer version-specific overrides. Include:

- Reason.
- Reviewer.
- Expiry or follow-up.
- Linked issue or pull request when available.

Revoke overrides when the reason is no longer true.
