# Anvil Desktop update service

This Worker serves signed macOS update metadata and release binaries from a private R2 bucket. Electron and the public website never read GitHub release assets during the normal update path.

## Public routes

| Route                                           | R2 key                                      | Cache policy                                      |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| `/v1/macos/arm64/feed.json`                     | `macos/arm64/feed.json`                     | 60 seconds in clients, 5 minutes at shared caches |
| `/v1/macos/arm64/latest/Anvil-latest-arm64.dmg` | `macos/arm64/latest/Anvil-latest-arm64.dmg` | 60 seconds in clients, 5 minutes at shared caches |
| `/v1/macos/arm64/releases/<version>/<asset>`    | `macos/arm64/releases/<version>/<asset>`    | One year, immutable                               |

All other R2 keys remain private. The Worker accepts `GET` and `HEAD`, streams object bodies, preserves conditional requests, and supports byte ranges.

## Rate limits

- Update feed: 120 requests per minute per source IP.
- DMG and ZIP assets: 30 requests per minute per source IP.

These limits are deliberately above normal use. Anvil checks once after startup and then every four hours. The higher feed limit avoids blocking teams behind one NAT address, while the asset limit stops simple download loops without breaking normal range requests.

## Deploy

From `anvil-app/`:

```bash
pnpm --dir updates-worker run types:check
pnpm --dir updates-worker run typecheck
pnpm --dir updates-worker run test
pnpm --dir updates-worker run dry-run
pnpm --dir updates-worker run deploy
```

The manual `Anvil Desktop Updates Cloudflare` GitHub workflow creates the `anvil-desktop-releases` bucket when needed and deploys the Worker. Configure these repository secrets first:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_DEPLOY_API_TOKEN`, scoped to deploy this Worker and create or bind the release bucket
- `CLOUDFLARE_R2_API_TOKEN`, scoped only to write release objects to the bucket

After the first deploy, set the repository variable `ANVIL_UPDATE_ORIGIN` to the exact HTTPS Worker origin. Set the same environment variable for the website deployment. The signed macOS release workflow embeds that origin in the app, generates the update feed, and uploads versioned assets before replacing the mutable `latest` DMG and feed.

Keep the R2 development URL disabled. A `workers.dev` origin is suitable for the current alpha distribution. A custom domain can replace it once an Anvil domain is managed by the same Cloudflare account.
