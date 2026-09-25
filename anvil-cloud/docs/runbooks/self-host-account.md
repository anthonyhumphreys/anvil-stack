# Self-host account and device operations

Self-hosted Sync & Mesh has no hosted account page. The operator surface is
the `anvil-cloud` CLI, which calls the backend's public enrollment and RPC
routes. It does not require WorkOS, `HOSTED_DB`, billing, or a website
deployment.

## Bootstrap the first device

Set the deployment admin secret in the environment. This is the value stored
in the Worker as `ENROLLMENT_ADMIN_TOKEN`; it is never passed as a command
argument, forwarded to the Wrangler subprocess environment, or printed by the
CLI. When the plan includes `--enrollment-admin`, `mesh apply` installs it after
deploy through Wrangler stdin.

```sh
export ANVIL_MESH_ADMIN_TOKEN='read-from-your-secret-store'
anvil-cloud mesh account bootstrap \
  --url https://mesh.example.test \
  --account my-account
```

The command prints one single-use enrollment code. Enter it in Anvil Desktop
when adding the first device. To consume the result from automation, append
`--json`; the response contains `{ "ok": true, "accountId": "…", "code": "…" }`.

## Manage enrolled devices

After the first device has enrolled, obtain its access token from the device's
local session store and expose it only to the process running the CLI:

```sh
export ANVIL_MESH_ACCESS_TOKEN='device-access-token'
anvil-cloud mesh account devices --url https://mesh.example.test
anvil-cloud mesh account rename --url https://mesh.example.test \
  --enrollment <enrollment-id> --name 'Office laptop'
anvil-cloud mesh account revoke --url https://mesh.example.test \
  --enrollment <enrollment-id>
```

The device commands use the authenticated `device.list`, `device.rename`, and
`device.revoke` RPC operations. The admin secret cannot list or revoke devices;
it is intentionally limited to issuing the first enrollment code. For the
strongest key-rotation guarantee, revoke a device from another trusted device
in Anvil Desktop.

The token environment variable names are configurable with
`--admin-token-env` and `--access-token-env`. The CLI rejects non-HTTPS remote
URLs (localhost is allowed for development), follows redirects only when the
fetch implementation permits them, and never includes either token in output.
