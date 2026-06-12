---
title: Authentication
navTitle: Auth
description: Declare access on handlers, verify real tokens locally and in the cloud, and plug in any OIDC provider with configuration.
product: Anvil Cloud
section: Architecture
order: 118
---

# Authentication

Anvil Cloud auth has one design rule: Cell code never talks to an auth provider. Handlers declare what access they need, the runtime enforces it, and adapters verify tokens. Local development and cloud deployments run the same verification path, so "works locally" means the auth logic is actually exercised, not mocked away.

## Declare access on handlers

Queries, mutations, and endpoints accept an `auth` declaration:

```ts
queries: {
  publicStats: query({
    auth: "public",
    handler: async () => ({ visitors: 42 }),
  }),
  myNotes: query({
    auth: "required",
    handler: async (ctx) => {
      return ctx.db.notes.where("ownerId", "=", ctx.auth.requireUser()).all();
    },
  }),
},
mutations: {
  resetAll: mutation({
    auth: { roles: ["admin"] },
    handler: async () => ({ reset: true }),
  }),
},
```

| Value | Behaviour |
| --- | --- |
| `"public"` | Runs without identity. (`"none"` is an endpoint alias.) |
| `"optional"` | Runs with or without identity; the handler decides via `ctx.auth`. |
| `"required"` | Rejects with `401 AUTH_REQUIRED` before the handler runs. |
| `{ roles: [...] }` | Requires identity plus at least one listed role; otherwise `403 FORBIDDEN`. |

Defaults: queries and mutations default to `"optional"` (handler-enforced); endpoints default to `"required"`. Declarations are recorded in the manifest (`authPolicies` and per-endpoint `auth`), so adapters and tooling can see the access surface without reading handler code.

Inside handlers, `ctx.auth` is unchanged: `identity`, `userId`, `requireUser()`, `hasRole(role)`, `requireRole(role)`.

## Local development: a real identity provider

Anvil Local runs an actual identity provider, not a mock. It generates an ES256 keypair under `.anvil/local/auth/`, keeps a user store, and signs real JWTs that are verified on every request. Forged or expired tokens are rejected locally exactly as they would be in production.

```bash
anvil auth add-user dev_1 --email dev@example.test --roles admin
anvil auth login dev_1          # sets ambient identity + prints a token
anvil auth token dev_1 --ttl 3600   # mints a JWT (perfect for agents and curl)
anvil auth users
anvil auth whoami
```

All commands support `--json`. An agent that needs an authenticated session is two commands away:

```bash
TOKEN=$(anvil auth token dev_1 --json | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" \
  -d '{"input":{}}' http://localhost:8787/_anvil/query/myNotes
```

The local runtime also exposes auth routes:

| Route | Purpose |
| --- | --- |
| `POST /_anvil/auth/users` | Create a user (`userId`, `email?`, `roles?`, `claims?`). |
| `GET /_anvil/auth/users` | List users. |
| `DELETE /_anvil/auth/users/:id` | Remove a user. |
| `POST /_anvil/auth/token` | Issue a JWT (`userId`, `ttlSeconds?`). |
| `GET /_anvil/auth/jwks` | Public JWKS for the local issuer. |
| `GET /_anvil/auth/whoami` | Resolve the bearer token or ambient identity. |
| `POST /_anvil/auth/as/:id` | Set the ambient dev identity (creates the user if needed). |

Ambient identity (set by `login` or `/as/`) is a convenience for browser-based dev flows; bearer tokens always win when present.

## Deployed: bring any OIDC provider

The AWS adapter verifies bearer tokens against any OIDC-compliant issuer. Configuration is environment, not code:

| Variable | Meaning |
| --- | --- |
| `ANVIL_AUTH_ISSUER` | OIDC issuer URL (enables verification). |
| `ANVIL_AUTH_AUDIENCE` | Expected `aud` claim (recommended). |
| `ANVIL_AUTH_JWKS_URI` | Optional explicit JWKS URL; otherwise OIDC discovery is used. |
| `ANVIL_AUTH_USER_ID_CLAIM` | Claim mapped to `userId` (default `sub`). |
| `ANVIL_AUTH_EMAIL_CLAIM` | Claim mapped to `email` (default `email`). |
| `ANVIL_AUTH_ROLES_CLAIM` | Claim mapped to `roles` (defaults try `roles`, `cognito:groups`, `groups`). |

Cognito, Auth0, Clerk, Entra ID, and anything else speaking OIDC are configuration choices, not adapter rewrites. Tokens are verified inside the runtime (JWKS signature, issuer, audience, expiry); failed verification returns `401` with a stable error code before any handler runs.

Identity supplied in request bodies is **ignored by default** in deployed runtimes. The `ANVIL_AUTH_ALLOW_BODY_IDENTITY=true` escape hatch exists for test harnesses and nothing else.

## Browser client

The generated client attaches tokens automatically:

```ts
const client = createClient({
  getToken: () => localStorage.getItem("token"),
});

// or imperatively:
client.setToken(token);
```

## Testing

The in-memory test host verifies tokens too:

```ts
const host = createInMemoryRuntimeHost({ auth: { userId: "user_1" } });

host.auth.registerToken("test-token", { userId: "user_2", roles: ["admin"] });
```

Unknown tokens throw, so a missing `registerToken` shows up as a failing test rather than a silently authenticated one.

## Extending to other providers and platforms

The contract is small on purpose:

- `TokenVerifier` (`@anvil-cloud/auth`): `verifyToken(token) → VerifiedToken`. The OIDC implementation covers most providers; non-OIDC providers implement this one interface.
- `AuthAdapter` (runtime host): `current()` plus optional `verifyToken()`. A future platform adapter supplies its own and nothing else changes.
- Claims mapping is data (`ClaimsMapping`), so provider quirks live in configuration.

## Current limits

- No session/refresh-token management; Cells receive verified identities, token lifecycle belongs to your provider or client.
- No built-in login UI; the local IdP issues tokens directly, and deployed apps use their provider's hosted flows.
- Role checks are membership checks; fine-grained permission policies are on the roadmap.
