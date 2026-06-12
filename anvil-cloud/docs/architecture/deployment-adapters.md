# Deployment Adapter Architecture

## Purpose

Deployment adapters map the provider-neutral Anvil Cell contract to a concrete hosting environment.

The core runtime, builder, manifest, client SDK, and CLI must not depend on a specific cloud provider. They should describe capabilities such as compute, database, files, logs, environment values, HTTP ingress, and jobs. Adapters translate those capabilities into provider resources.

AWS is the first planned deployment adapter for alpha. That should prove the adapter contract, not turn AWS into the Cell authoring model.

## Goals

- Keep Cell code portable across local and deployed runtimes.
- Define a stable adapter boundary for deployment planning, provisioning, runtime hosting, logs, and inspection.
- Keep provider-specific resource names and deployment mechanics out of core specs.
- Let `anvil deploy --preview --json` return stable JSON regardless of adapter.
- Allow future adapters without changing Cell handler code.

## Non-goals

- Implementing more than one production cloud adapter during alpha.
- Abstracting every cloud provider feature.
- Supporting arbitrary containers, Kubernetes, or enterprise networking during alpha.
- Hiding meaningful provider differences behind vague names.

## Adapter contract

A deployment adapter should provide:

- a runtime host implementation;
- trigger translation into `RuntimeRequest`;
- `RuntimeResponse` translation back to the provider;
- deployment plan generation;
- artefact upload;
- capability-to-resource mapping;
- logs and inspection readers;
- policy inputs for Anvil Guard.

## Provider-neutral capability mapping

Core Anvil concept names should stay provider-neutral:

| Anvil concept      | Adapter responsibility                         |
| ------------------ | ---------------------------------------------- |
| Cell runtime       | Execute server handlers                        |
| Query/mutation API | Expose runtime RPC routes                      |
| Custom endpoints   | Expose declared HTTP routes                    |
| Client bundle      | Serve static client assets                     |
| Database           | Store Cell table data                          |
| Files              | Store Cell-owned objects                       |
| Environment        | Provide config and secrets                     |
| Logs               | Store structured runtime logs                  |
| Scheduled jobs     | Invoke named jobs on schedules                 |
| Queued jobs        | Persist and invoke queued work                 |
| Deploy metadata    | Store deployment state and manifest references |
| Audit events       | Store deploy and policy events                 |

## Deployment plan shape

Adapters should emit a provider-neutral deployment plan before provisioning:

```json
{
  "schemaVersion": "0.1",
  "adapter": "aws",
  "environment": "preview",
  "cell": "notes",
  "changes": [
    {
      "kind": "create",
      "concept": "database",
      "name": "notes"
    }
  ],
  "warnings": []
}
```

Provider resource identifiers belong in adapter-specific detail fields or deployment results, not in the core manifest.

## Implementation order

1. Prove the local runtime and builder.
2. Define the deployment adapter contract.
3. Implement the AWS preview adapter against that contract.
4. Add further adapters only after alpha validates the contract.
