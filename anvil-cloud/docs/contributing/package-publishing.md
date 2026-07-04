# Package Publishing Boundaries

Anvil Cloud is a workspace, not a bag of public npm packages.

## Public packages

The only public npm package in the alpha is:

- `@anvilstack/cloud-cli`

It owns the `anvil-cloud` binary and is the supported installation surface for
humans, agents, examples, and CI smoke workflows.

## Internal packages

These workspace packages are private implementation details during alpha:

- `@anvil-cloud/auth`
- `@anvil-cloud/aws`
- `@anvil-cloud/builder`
- `@anvil-cloud/client`
- `@anvil-cloud/control-plane`
- `@anvil-cloud/local`
- `@anvil-cloud/runtime`

Examples and docs may import internal packages through workspace aliases, but
that does not make those imports public API. The CLI package bundles or depends
on those internals as needed. Users should install the CLI, not the internals.

## First public API candidates

When the alpha contract is stable enough, the likely public surfaces are:

1. the CLI package;
2. the Runtime authoring DSL for Cell source;
3. the generated-client/client SDK surface.

`anvil-cloud doctor --json` reports these likely next surfaces under
`packages.publicBoundary.details.candidatePublicApis`, but they remain private
until the package-boundary test and this document are updated in the same
change. Naming a candidate is not publishing it. Thankfully, words still do not
upload packages to npm by themselves.

Builder, Local, AWS, Auth, and Control Plane packages should stay private until
their contracts are intentionally documented, versioned, and tested as external
APIs. Shipping them early would be an impressively efficient way to support
bugs we have not even designed yet.

## Promotion criteria

A package can move from internal workspace detail to public API only when the
contract it exposes is already the supported mental model in docs, examples,
tests, and generated output.

`@anvil-cloud/runtime` can become public when:

- Cell authoring imports are limited to provider-neutral primitives such as
  `app`, `query`, `mutation`, `endpoint`, `job`, `workflow`, `service`,
  `table`, field builders, and agent definitions;
- provider adapters remain invisible to Cell source;
- Guard rejects direct provider SDKs, direct environment reads, undeclared
  capabilities, undeclared env names, undeclared outbound domains, public file
  exposure changes, and destructive schema changes before release paths imply
  safety;
- the Notes example and starter templates use only the same public authoring
  surface.

`@anvil-cloud/client` can become public when:

- generated query and mutation metadata is stable and documented;
- `createClient`, `createApiClient`, hooks, token lookup, structured runtime
  errors, and manual refetch have direct tests and example coverage;
- Vite React, Expo Router, and headless client targets all consume the same
  generated-client contract without runtime- or adapter-specific imports;
- versioned type exports are treated as compatibility commitments.

`@anvil-cloud/builder`, `@anvil-cloud/local`, `@anvil-cloud/aws`,
`@anvil-cloud/auth`, and `@anvil-cloud/control-plane` stay private until their
own user-facing contracts are documented separately. For now they are allowed to
change to keep the CLI, Runtime authoring DSL, generated client, and platform
contract honest.

## Current boundary matrix

| Package | Current status | Public role now | Promotion note |
| --- | --- | --- | --- |
| `@anvilstack/cloud-cli` | Public | Owns `anvil-cloud` commands and examples. | Keep public. |
| `@anvil-cloud/runtime` | Private | Workspace authoring DSL used by examples and generated Cells. | First runtime API candidate. |
| `@anvil-cloud/client` | Private | Generated client runtime used by starter clients. | First client SDK candidate. |
| `@anvil-cloud/builder` | Private | Manifest, Guard, generated-client, and bundle implementation. | Promote only if Builder becomes a supported library API. |
| `@anvil-cloud/local` | Private | Local runtime host and dev server implementation. | Keep behind CLI/local commands. |
| `@anvil-cloud/aws` | Private | AWS preview adapter, plans, remote inspection, logs, and cleanup. | Keep adapter-specific. |
| `@anvil-cloud/auth` | Private | Local and OIDC auth implementation used by hosts. | Promote only with a documented auth API. |
| `@anvil-cloud/control-plane` | Private | Control-plane implementation detail. | Keep internal. |

## Guardrail

The CLI test suite includes a package-boundary check that asserts:

- `@anvilstack/cloud-cli` is the only public package;
- `@anvil-cloud/runtime` and `@anvil-cloud/client` are tracked as candidate
  public APIs but remain private;
- public packages have `publishConfig.access: "public"`;
- public packages do not publish `workspace:` dependencies in `dependencies`,
  `optionalDependencies`, or `peerDependencies`;
- internal workspace packages remain `private: true`.

Update the docs and that test together when deliberately changing the package
boundary.
