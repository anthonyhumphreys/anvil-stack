# Mezair identity cutover

This change establishes one Mezair identity across Desktop, Companion, Cloud,
Registry, Node Base, the website, worker images, daemons, CLI packages and docs.
It is a coordinated namespace change. Successful local checks do not provision
public domains, publish packages or migrate a running deployment.

## Build a fresh checkout

The four projects retain independent workspaces and lockfiles. Desktop bundles
the two locally built public CLI surfaces, so prepare them before installing
Desktop dependencies:

```sh
node .github/scripts/prepare-desktop-clis.mjs
cd mezair-app
pnpm install
pnpm build
```

The helper installs Cloud and Registry with their frozen locks and builds both
CLI entry points. Desktop's file dependencies avoid relying on an unpublished
new npm scope. Production publishing still requires control of `@mezairstack`.

## Profiles, data and protocol compatibility

Desktop uses the Mezair application identity, `mezair.db`, `.mezair` directories,
`mezair://` protocol, `window.mezair` preload bridge and `MEZAIR_*` configuration.
The existing development profile override is `MEZAIR_DEV_USER_DATA_PATH`.

The preceding product identity's profile files are not rewritten or removed by
this source change. This release does not provide an automatic migration of
that identity's databases or saved credentials. Keep a recoverable copy of the
previous profile before adopting the new identity. Do not copy its database,
keychain entries or encrypted backend records into a fresh Mezair profile and
assume they will be readable.

Branded cryptographic contexts, recovery proofs, pairing codes, protocol
identifiers, share/package formats, storage prefixes and persisted ownership
values now use Mezair. Existing ciphertext, recovery material, device pairings,
share links and exported packages from another identity are not interchangeable.
No compatibility alias or encoded former namespace is shipped. Decryption,
signature verification and protocol validation continue to fail closed.

Adopt Desktop, Companion, daemon, website, Sync/Mesh backend, provisioner and
worker images together. Use fresh account enrollment, pairing and credentials
for the new namespace. Moving existing data requires a separately reviewed,
explicit migration that can decrypt and re-encrypt it with its legitimate keys;
that migration is not implemented by this rebrand.

## External release prerequisites

Before making a public release or enabling a hosted connection:

- Establish control of `mezair.dev`, its required subdomains and TLS/DNS.
  Configure the website and service URLs explicitly for the deployment.
- Configure WorkOS applications, allowed origins and browser/device callbacks
  for the new site and application schemes. Rotate or re-enter deployment
  credentials through the intended secret stores.
- Establish the intended `anthonyhumphreys/mezair-stack` repository identity
  before relying on the source and release links in product metadata. The
  source change does not rename the remote repository.
- Publish the new npm packages and GHCR worker/Node Base images. Configure
  GitHub environments, variables and secrets for the renamed workflows.
- Provision the new Cloudflare Worker, D1, R2, Queue, Container and Tunnel
  identities where used. A renamed config is not proof of a migrated resource.
- Configure the desktop signing/notarisation and mobile bundle/application
  identifiers, provisioning profiles, store records and release credentials.
- Install the new launchd/systemd daemon labels and file/protocol associations
  deliberately. Confirm ownership and execution before retiring a previous
  installation.

Retain the previous deployment and recoverable data until an operator has
verified the new namespace end to end. No deployment, domain registration,
package publication or production data migration is performed by this change.

## Identity verification

Audit current owned source contents and tracked paths without case sensitivity.
Also inspect ZIP/XML document contents, OCR raster documents and review the
actual logo shapes. Git object history and third-party dependency caches are
outside the product source audit. Six obsolete pre-rebrand review captures were
retired because their embedded identity could not represent this build.

Verify the four project builds and relevant suites, Companion typechecks/lint,
CLI entry points, backend configuration fixtures and release workflow parsing.
Browser screenshots prove presentation; native installed-app, physical-device,
signing and live hosted acceptance remain separate release checks.
