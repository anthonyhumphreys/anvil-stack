# Anvil Agents Examples

These examples show the first-pass Anvil Agents contract model:

- `local-project-agent`: a project-level Cell reviewer using the local stub provider.
- `local-agent-cell`: an Agent Cell that mounts a local support assistant.
- `aws-bedrock-agent-cell`: an Agent Cell configured for the AWS Bedrock provider.
- `provider-registration`: local and AWS provider registration without changing the agent contract.

Run contract checks from a Cell project with:

```sh
anvil-cloud agents validate
anvil-cloud agents manifest --json
anvil-cloud agents invoke support --input "Review this Cell"
```

Local stub mode does not call external APIs. Provider mode uses the same Anvil runtime contract with a registered provider.

To scaffold a runnable Cell from these patterns, use:

```sh
anvil-cloud new support-cell --template agent --client headless
anvil-cloud new sandbox-cell --template sandbox --client headless
```

Templates keep the starter generated client path working and add the selected
agent primitive on top so coding agents can extend a passing Cell instead of
debugging an empty sketch.
