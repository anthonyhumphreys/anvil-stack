# Deployment adapters

Anvil defines app capabilities. Deployment adapters realise those capabilities on a target platform. The AWS adapter currently uses Pulumi internally for planning and deployment, but Pulumi is not part of the Cell authoring contract.

## Layers

1. **Authoring layer**: Anvil Cells declare routes, handlers, tables, secrets, jobs, policies, workflows, and other application intent. Normal Cell definitions import Anvil packages only; they do not import Pulumi, AWS SDKs, Terraform, CDK, Kubernetes, or raw infrastructure resources.
2. **Cell graph layer**: Anvil Builder compiles a Cell manifest into a provider-neutral `AnvilCellGraph`. The graph is stable, serialisable, inspectable, and contains Anvil concepts such as HTTP routes, functions, tables, secrets, and permissions.
3. **Adapter layer**: deployment adapters consume the graph through an `AnvilDeployAdapter`-style contract with `plan`, `deploy`, and `remove` operations. Local runtime code stays Pulumi-free. Cloud adapters may choose an engine internally.
4. **Engine layer**: the AWS adapter currently uses Pulumi as its realisation engine. Pulumi resource mappings are implementation details and are only shown by explicit verbose/debug output.

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

Human-readable plan output lists Anvil concepts first, for example cells, HTTP routes, functions, tables, secrets, and permissions. Use `--verbose` or `--debug` to include underlying Pulumi resource mappings while diagnosing adapter behaviour.

## Non-goals

Anvil is not a Pulumi authoring surface. Users should not write Pulumi components for Cells, and generated manifests should not require Pulumi concepts. Future adapters may use Terraform/OpenTofu, CDK, Kubernetes, direct provider APIs, or another engine without changing Cell authoring.
