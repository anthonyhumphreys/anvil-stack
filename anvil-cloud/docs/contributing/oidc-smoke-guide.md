# AWS Preview OIDC Smoke Guide

Use this guide to run the AWS preview smoke Cell with authenticated requests.
The goal is to prove that preview runtime auth is rejecting anonymous and forged
requests, rejecting expired bearer tokens when supplied, and accepting a real
OIDC bearer token for protected handlers.

## What The Runtime Reads

AWS preview runtime auth is configured through environment variables:

- `ANVIL_AUTH_ISSUER`: required for OIDC verification.
- `ANVIL_AUTH_AUDIENCE`: recommended; required when your tokens include an
  audience and you want Anvil to enforce it.
- `ANVIL_AUTH_JWKS_URI`: optional; use it when discovery is unavailable or you
  want to pin the JWKS endpoint.
- `ANVIL_AUTH_USER_ID_CLAIM`: optional; defaults to `sub`.
- `ANVIL_AUTH_EMAIL_CLAIM`: optional; defaults to `email`.
- `ANVIL_AUTH_ROLES_CLAIM`: optional; defaults to `roles` and also supports
  `cognito:groups`.

The preview verifier also uses local smoke variables:

- `ANVIL_AWS_ARTIFACT_BUCKET`: required for preview deploy.
- `AWS_REGION` or `AWS_DEFAULT_REGION`: required by AWS SDK configuration.
- `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE`: recommended for remote inspect/logs.
- `ANVIL_AWS_SMOKE_TOKEN`: bearer token used for authenticated mutation/query
  checks.
- `ANVIL_AWS_EXPIRED_SMOKE_TOKEN`: optional expired bearer token used to prove
  expiry rejection against the deployed runtime.
- `ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN`: optional bearer token used to prove
  issuer rejection against the deployed runtime.
- `ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN`: optional bearer token used to prove
  audience rejection against the deployed runtime.
- `ANVIL_AWS_SMOKE_KEEP_STACK=1`: optional; keeps the stack for manual
  inspection.

Run `anvil-cloud doctor --json` before deploying. It reports whether the AWS,
OIDC, and `ANVIL_AWS_SMOKE_TOKEN` variables are visible to the current shell.
The `auth.oidc.details.claims` object also shows the effective user id, email,
and roles claim names, including whether each came from an explicit
`ANVIL_AUTH_*_CLAIM` variable or the default mapping. Very glamorous. Very
useful.

## Provider Setup

Use an OIDC provider that can issue JWTs with:

- `iss` exactly matching `ANVIL_AUTH_ISSUER`;
- `aud` matching `ANVIL_AUTH_AUDIENCE`, if audience enforcement is enabled;
- a stable user id claim, usually `sub`;
- optional `email` and role/group claims.

For providers with standard discovery, `ANVIL_AUTH_ISSUER` is enough for JWKS
discovery. For providers without discovery, set `ANVIL_AUTH_JWKS_URI` directly.

If your provider does not use `sub`, `email`, or `roles`/`cognito:groups`,
configure the claim mapping explicitly:

```sh
export ANVIL_AUTH_USER_ID_CLAIM=uid
export ANVIL_AUTH_EMAIL_CLAIM=mail
export ANVIL_AUTH_ROLES_CLAIM=scp
```

The mapped user id claim is required. A token can pass signature, issuer, and
audience validation and still fail the smoke if it cannot be mapped to an Anvil
identity. Decorative JWT success is still failure. Security loves paperwork.

## Smoke Run

From the `anvil-cloud` workspace:

```sh
export AWS_REGION=eu-west-2
export ANVIL_AWS_ARTIFACT_BUCKET=<artifact-bucket>
export ANVIL_AWS_DEPLOYMENT_METADATA_TABLE=<metadata-table>

export ANVIL_AUTH_ISSUER=https://issuer.example.com/
export ANVIL_AUTH_AUDIENCE=anvil-preview
export ANVIL_AWS_SMOKE_TOKEN=<oidc-jwt-for-that-issuer-and-audience>
# Optional, but recommended when your provider can issue or retain an expired test token.
export ANVIL_AWS_EXPIRED_SMOKE_TOKEN=<expired-oidc-jwt-for-that-issuer>
# Optional, but recommended for the complete negative-auth smoke.
export ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN=<oidc-jwt-from-a-different-issuer>
export ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN=<oidc-jwt-for-a-different-audience>

pnpm build
pnpm verify:aws-preview
```

The verifier deploys `examples/aws-preview`, waits for health, checks a public
status query, verifies anonymous `listNotes` is rejected with `AUTH_REQUIRED`,
verifies a forged bearer token is rejected, verifies
`ANVIL_AWS_EXPIRED_SMOKE_TOKEN`,
`ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN`, and
`ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN` are rejected when supplied, runs
authenticated `createNote` and `listNotes` when `ANVIL_AWS_SMOKE_TOKEN` is
present, reads remote inspect/logs, and destroys the preview stack unless
`ANVIL_AWS_SMOKE_KEEP_STACK=1` is set.

## Expected Negative Auth Results

- No bearer token on protected handlers: HTTP `401`, `AUTH_REQUIRED`.
- Forged bearer token with OIDC configured: HTTP `401`, `TOKEN_INVALID`.
- Wrong issuer: `ISSUER_MISMATCH`.
- Wrong audience: `AUDIENCE_MISMATCH`.
- Expired token: `TOKEN_EXPIRED` or, for providers that hide expiry details
  behind signature validation, `TOKEN_INVALID`.
- Missing mapped user id claim: `TOKEN_INVALID`.

If a forged bearer token returns `AUTH_REQUIRED`, the runtime probably did not
receive OIDC config and treated the request as anonymous. Check the deployed
Lambda environment and rerun `anvil-cloud doctor --json` locally to catch shell
configuration drift before redeploying.

Before calling AWS preview auth broadly done, verify all of these:

- anonymous protected query is rejected;
- forged bearer token is rejected;
- valid bearer token can create and list a note;
- token with the wrong issuer fails;
- token with the wrong audience fails when `ANVIL_AUTH_AUDIENCE` is set;
- expired token fails;
- custom claim mapping works when configured;
- `inspect`, `logs`, and `destroy` still work after the authenticated smoke.

## Manual Checks

After a kept stack deploy:

```sh
node packages/cli/dist/index.js inspect --app aws-preview --env preview --json
node packages/cli/dist/index.js logs --app aws-preview --env preview --since 10m --json
node packages/cli/dist/index.js destroy --preview --app aws-preview --yes --json
```

Destroy should clean the preview stack and deployment metadata. If cleanup fails,
inspect the returned AWS destroy diagnostic before deleting resources manually.
