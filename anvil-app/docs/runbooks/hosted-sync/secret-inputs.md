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

As of 30 September 2026, both internal Environments have been created. Staging
contains four backend secrets, `ANVIL_DEPLOYMENT_ENV`, and seven website
variables named `ANVIL_STAGING_*`. After the native 1Password mount approval,
the wrapper read all four backend secrets and matched them to the prior staging
values. The ignored local staging manifest selects `backendEnvFile`; backend
and provisioner secrets were reinstalled from the mount successfully. Production
contains only its environment marker and has not been deployed. The website
`.env` remains for local development. On 2 October, website values were installed
as Vercel Preview overrides for `develop` and `feature/sync-mesh--foundations`.
The WorkOS API key, cookie password, and hosted service secret are sensitive
variables. The four backend secrets were installed in GitHub's `anvil-staging`
environment for guarded CI deployment. The old ignored backend JSON and provisioner token files were
removed after the reinstall succeeded.

Production isolation checks load the Staging source independently to compare
values across environments. A process-only Staging source cannot be loaded for
that comparison, so production operations must fail closed until an independent
Staging source is available.

Website values may also use names such as `ANVIL_STAGING_*` and
`ANVIL_PRODUCTION_*`. Send only the website-specific values to the matching
Vercel environment. Never export the complete backend dotenv source to Vercel:
it can contain Worker-only credentials such as `WORKOS_API_KEY`, Stripe keys,
webhook secrets, and HMAC keys.
