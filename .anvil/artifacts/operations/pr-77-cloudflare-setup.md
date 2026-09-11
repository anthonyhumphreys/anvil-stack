# PR 77 Cloudflare setup

## Values required

| Name | Find it in | Save it in |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account details | GitHub Actions secret |
| `CLOUDFLARE_DEPLOY_API_TOKEN` | Cloudflare API Tokens | GitHub Actions secret |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | R2 API token result | GitHub Actions secret |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 API token result | GitHub Actions secret |
| `ANVIL_UPDATE_ORIGIN` | Deployed Worker's public URL | GitHub Actions variable and Vercel environment variable |

The deploy token and R2 credentials are separate. Do not use the deploy token as an R2 access key.

## 1. Find the Cloudflare account ID

In the [Cloudflare dashboard](https://dash.cloudflare.com/):

1. Open the correct account.
2. Press `Cmd+K`.
3. Search for `Copy account ID`.
4. Copy the 32-character value.

Cloudflare also shows it under **Workers & Pages > Account Details**. [Cloudflare account ID instructions](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)

## 2. Create the Worker deployment token

Open **Cloudflare > My Profile > API Tokens > Create Token > Create Custom Token**.

Name it `anvil-github-actions-deploy`.

Grant these permissions:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Account Settings | Read |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| User | User Details | Read |
| User | Memberships | Read |

Restrict account resources to the Cloudflare account that will own Anvil. No zone permission is needed for the initial `workers.dev` deployment.

Create the token and copy its value. Cloudflare only displays it once. These permissions match the documented Worker deployment set, with R2 edit required because the workflow creates the bucket. [Cloudflare token permissions](https://developers.cloudflare.com/fundamentals/api/reference/template/)

## 3. Save the initial GitHub secrets

Open [anvil-stack Actions secrets](https://github.com/anthonyhumphreys/anvil-stack/settings/secrets/actions) and create: