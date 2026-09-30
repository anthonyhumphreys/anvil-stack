# Hosted backend secret inputs

The hosted deploy wrapper accepts exactly one backend secret source per target:

- `secrets.backendFile`: the existing provider-neutral JSON file workflow. In
  this mode, `secrets.provisionerTokenFile` remains the separate token file for
  the managed provisioner.
- `secrets.backendEnvFile`: a dotenv-format file containing the backend
  secrets. A `MANAGED_PROVISIONER_TOKEN` in this source also supplies the
  managed provisioner token.
- `secrets.backendEnv: "process"`: backend secrets supplied in the wrapper's
  process environment. A process `MANAGED_PROVISIONER_TOKEN` also supplies the
  managed provisioner token.

Choose one of these modes for a target; do not combine them. Both dotenv and
process sources must include `ANVIL_DEPLOYMENT_ENV=staging` or
`ANVIL_DEPLOYMENT_ENV=production`, matching the selected target. The wrapper
filters backend secrets through its allowlist, so extra website variables in a
dotenv source are not installed on the Worker. It validates and passes secret
values to the underlying CLI through restricted temporary files, then removes
those files when the command finishes, including on failure.

## Optional mounted 1Password input

The internal 1Password Environments are named **Anvil hosted staging** and
**Anvil hosted production**. The intended mount paths, relative to
`anvil-app/cloud/backend/`, are:

```text
.wrangler/hosted-secrets/staging.env
.wrangler/hosted-secrets/production.env
```

The checked-in `hosted-targets.example.json` continues to use the provider-
neutral `backendFile` and `provisionerTokenFile` fields. It does not require
1Password settings.

Point each target's `secrets.backendEnvFile` at its matching mounted path. A
mount may be a FIFO (named pipe); see [1Password's local environment file
documentation](https://www.1password.dev/environments/local-env-file). Do not
`source` or `eval` it, overwrite the mount, or run `chmod` on it. Avoid
concurrent readers, and do not print secret contents. For deployment, let the
wrapper consume the mount as a dotenv input. The wrapper has no dependency on
the 1Password CLI. The JSON file workflow needs no 1Password setup and remains
suitable for open-source users, self-hosters, and CI.

Select one source in the target manifest. For example, use this for the
Staging mount:

```json
"secrets": {
  "backendEnvFile": ".wrangler/hosted-secrets/staging.env"
}
```

Or use the invoking process environment:

```json
"secrets": {
  "backendEnv": "process"
}
```

With either dotenv or process mode, set `ANVIL_DEPLOYMENT_ENV` to the selected
target. Once the source is configured (and process variables are available to
the wrapper), the deployment command is unchanged:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging secrets --json
```

The wrapper reads the selected source and supplies it to the CLI. Do not add
secret values to the command line.

As of 30 September 2026, both internal Environments have been created. The
Staging import is confirmed with four backend secrets, `ANVIL_DEPLOYMENT_ENV`,
and seven website variables named `ANVIL_STAGING_*`. The mounted read
returned zero bytes while the native "Populate file staging.env" authorization
was pending. The mount is not verified and the local manifest still selects
the existing JSON source. Production contains only its marker and no
credentials, and no Production deployment has occurred. The mounted Environment
inputs have not been used for a deployment. Existing local JSON and
provisioner-token files remain in place until mount verification and a
successful wrapper run. The website `.env` remains for local development;
website values in 1Password have not been synced to Vercel. Do not treat the
Staging import as mount verification; update this status after the mount can be
read successfully.

Production isolation checks load the Staging source independently to compare
values across environments. A process-only Staging source cannot be loaded for
that comparison, so production operations must fail closed until an independent
Staging source is available.

Website values may also use names such as `ANVIL_STAGING_*` and
`ANVIL_PRODUCTION_*`. Send only the website-specific values to the matching
Vercel environment. Never export the complete backend dotenv source to Vercel:
it can contain Worker-only credentials such as `WORKOS_API_KEY`, Stripe keys,
webhook secrets, and HMAC keys.
