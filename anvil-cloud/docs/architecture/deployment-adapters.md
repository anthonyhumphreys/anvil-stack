# Deployment adapters

Anvil defines app capabilities. Deployment adapters realise those capabilities on a target platform. The AWS adapter currently uses Pulumi internally for planning and deployment, but Pulumi is not part of the Cell authoring contract.

## Layers

1. **Authoring layer**: Anvil Cells declare routes, handlers, tables, secrets, jobs, policies, workflows, and other application intent. Normal Cell definitions import Anvil packages only; they do not import Pulumi, AWS SDKs, Terraform, CDK, Kubernetes, or raw infrastructure resources.
2. **Cell graph layer**: Anvil Builder compiles a Cell manifest into a provider-neutral `AnvilCellGraph`. The graph is stable, serialisable, inspectable, and contains Anvil concepts such as HTTP routes, functions, tables, secrets, and permissions.
3. **Adapter layer**: deployment adapters consume the graph through an `AnvilDeployAdapter`-style contract with `plan`, `deploy`, and `remove` operations. Local runtime code stays Pulumi-free. Cloud adapters may choose an engine internally.

4. **Engine layer**: the AWS adapter currently uses Pulumi as its realisation engine. Pulumi resource mappings are implementation details and are only shown by explicit verbose/debug output.

`validateAnvilCellGraph` rejects provider-specific graph field names and
provider/adapter values such as AWS, Pulumi, Vite, Expo, or Bedrock. Those words
are valid in adapters, providers, and client targets; they are not the Cell graph
mental model.

## Current vertical slice

The AWS adapter maps the provider-neutral graph as follows:

- HTTP route → API Gateway HTTP entrypoint.
- Function/runtime handler → Lambda.
- Table/storage → DynamoDB.
- Secret → SSM Parameter Store parameter.
- Logs → CloudWatch.
- Permissions → generated IAM role policies.
- Stage naming → deterministic `<app>-<stage>` resource prefixes.
- Outputs → Anvil-level endpoint, function names, table names, and secret references.

The CLI shape is app-first:

```sh
anvil-cloud dev
anvil-cloud inspect
anvil-cloud plan --stage dev --adapter aws
anvil-cloud deploy --stage dev --adapter aws
anvil-cloud remove --stage dev --adapter aws
```

Human-readable plan output lists Anvil concepts first, for example cells, HTTP
routes, functions, tables, secrets, and permissions. It also shows review gates,
cost drivers, and rollback notes so humans see the same important warnings that
automation sees in JSON. Use `--verbose` or `--debug` to include underlying
Pulumi resource mappings while diagnosing adapter behaviour.

JSON plan output is intentionally diffable. The top-level `changes` array keeps
the Anvil-first change list in stable action/concept/name order, while
`plan.review` adds stable ids and review metadata:

```json
{
  "stableId": "aws:notes:dev:deploy",
  "operation": "deploy",
  "changeSummary": [
    {
      "concept": "table",
      "creates": 1,
      "updates": 0,
      "reuses": 0,
      "total": 1,
      "changeIds": ["create:table:notes"]
    }
  ],
  "changeSet": [
    {
      "id": "create:table:notes",
      "action": "create",
      "concept": "Table",
      "name": "notes"
    }
  ],
  "capabilityDiffs": [
    {
      "id": "table:notes",
      "action": "add",
      "capability": "table",
      "name": "notes"
    }
  ],
  "cost": {
    "drivers": [
      {
        "id": "dynamodb",
        "label": "DynamoDB reads, writes, and storage"
      }
    ]
  },
  "rollback": {
    "supported": false,
    "strategy": "redeploy-or-remove"
  },
  "approvalSummary": {
    "required": 1,
    "info": 0,
    "review": 1,
    "block": 0,
    "hasBlockingGate": false
  },
  "approvalGates": [
    {
      "id": "data-resource-review",
      "required": true,
      "severity": "review"
    }
  ]
}
```

`changeSummary` is a compact concept-level index over `changeSet`; the
`changeIds` values are the same stable ids used by review gates and detailed
diffs.

`approvalSummary` is a compact count over `approvalGates`; automation can check
`hasBlockingGate` before deciding whether a plan is actionable.

`capabilityDiffs` compares the desired Cell graph with a previous graph when one
is supplied by the caller. Without a previous graph, the plan treats desired
capabilities as additions. That is conservative for first deploys and keeps the
review surface honest instead of pretending the adapter knows remote state it
has not inspected.

## Non-goals

Anvil is not a Pulumi authoring surface. Users should not write Pulumi components for Cells, and generated manifests should not require Pulumi concepts. Future adapters may use Terraform/OpenTofu, CDK, Kubernetes, direct provider APIs, or another engine without changing Cell authoring.
