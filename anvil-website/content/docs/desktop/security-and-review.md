---
title: Security and review
navTitle: Security and review
description: How Anvil Desktop approaches code review, security review, dependency risk, and evidence capture.
product: Anvil Desktop
section: Assurance
journey: reference
order: 118
---

# Security and review

Anvil Desktop review surfaces should help a developer decide whether a change deserves trust.

That means findings need file references, severity, reasoning, and validation notes. A vague warning is not a review finding; it is an anxious tooltip.

## Code review stance

Code review should prioritize:

1. correctness and behavioral regressions
2. security, auth, permissions, and unsafe execution
3. data integrity and migrations
4. accessibility
5. production risk
6. missing tests or missing verification
7. maintainability and readability
8. performance and developer experience

Style preferences belong below blockers. The system should make that separation visible.

## Security review stance

Security sessions are most important when a change touches:

- authentication or authorization
- user data or personal data
- secrets, tokens, or connector credentials
- shell execution, filesystem access, browser automation, or PTYs
- dependency installation
- release, deployment, signing, or notarization
- payment, billing, reporting, or compliance
- external provider calls

Findings should include:

- affected file or flow
- risk category
- why it matters
- likely exploit or failure mode where practical
- suggested fix
- verification status

## Dependency review

Anvil Desktop can surface dependency risk locally, but Anvil Registry is the stronger boundary for npm install policy. Use Registry when installs need gateway enforcement, package decision history, tarball cache identity, or org-wide policy.

Use Desktop dependency review when the task is local investigation or handover. Use Registry when the task is controlling package ingress.

## Evidence output

Good evidence has receipts:

- file and line references
- command output summaries
- test names or check names
- before and after behavior
- screenshots or browser checks when UI risk matters
- dependency decision IDs or reports
- notes for anything not verified

## Common failure modes

| Failure | Why it matters |
| --- | --- |
| Review without file references | The finding cannot be checked quickly. |
| Security review that only repeats OWASP labels | Labels are not evidence. |
| Tests mentioned without command names | The handover cannot distinguish verified work from optimism. |
| Ignoring data migrations | Local UI can pass while persisted state quietly breaks. |
| Treating LLM output as authority | The model can help investigate, but repo facts and deterministic gates still decide. |

## Handover rule

If a risk was not checked, say that plainly. Silence is not a control.
