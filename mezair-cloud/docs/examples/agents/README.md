# Mezair Agents Examples

These examples show the first-pass Mezair Agents contract model:

- `local-project-agent`: a project-level Cell reviewer using the local stub provider.
- `local-agent-cell`: an Agent Cell that mounts a local support assistant.
- `aws-bedrock-agent-cell`: an Agent Cell configured for the AWS Bedrock provider.
- `provider-registration`: local and AWS provider registration without changing the agent contract.

Run contract checks from a Cell project with:

```sh
mezair-cloud agents validate
mezair-cloud agents manifest --json
mezair-cloud agents invoke support --input "Review this Cell"
mezair-cloud approvals list --status pending --json
mezair-cloud eval --json
mezair-cloud eval --write-baseline --json
```

Local stub mode does not call external APIs. Provider mode uses the same Mezair runtime contract with a registered provider.
Approval-gated tools persist local pending decisions in `.mezair/local/approvals.json`; inspect or decide them with `mezair-cloud approvals list|approve|reject|audit`.

To scaffold a runnable Cell from these patterns, use:

```sh
mezair-cloud new support-cell --template agent --client headless
mezair-cloud new sandbox-cell --template sandbox --client headless
```

Templates keep the starter generated client path working and add the selected
agent primitive on top so coding agents can extend a passing Cell instead of
debugging an empty sketch.
