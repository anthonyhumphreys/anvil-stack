# Anvil Agents Examples

These examples show the first-pass Anvil Agents contract model:

- `local-project-agent`: a project-level Cell reviewer using the local stub provider.
- `local-agent-cell`: an Agent Cell that mounts a local support assistant.
- `aws-bedrock-agent-cell`: an Agent Cell configured for the AWS Bedrock provider.
- `provider-registration`: local and AWS provider registration without changing the agent contract.

Run contract checks from a Cell project with:

```sh
anvil agents validate
anvil agents manifest --json
anvil agents invoke support --input "Review this Cell"
```

Local stub mode does not call external APIs. Provider mode uses the same Anvil runtime contract with a registered provider.
