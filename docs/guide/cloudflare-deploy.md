# Deploy to Cloudflare Workers

> Deployment mode D: agility-bridge as a Cloudflare Worker on D1, reachable from every device, no server to run. First
> version (P3-05); the custom-domain, migration and client sections arrive with P3-07 and P3-09. Limits per plan:
> [Cloudflare limits](cloudflare-limits.md).

Workers reach only instances that are on the internet with publicly trusted certificates. For an on-premises Agility
or one with a private CA, run [`agility-bridge serve`](self-hosting.md) instead
([ADR-0014](../adr/0014-supported-agility-installations.md)).

## What you need

- A Cloudflare account (the Free plan works) and a checkout of this repository with `pnpm install` done.
- `wrangler` logged in to that account: `pnpm --filter @agility-bridge/worker exec wrangler login`. The setup script
  uses that login; it never reads or stores a Cloudflare token.

## Create or update a deployment

```sh
pnpm cf:setup --name agility-bridge-staging --secrets-file ~/.config/agility-bridge/staging.secrets
```

One command, safe to run again (a second run only redeploys). For the deployment named by `--name` it:

1. finds or creates the D1 database of the same name;
2. writes `apps/worker/wrangler.<name>.local.jsonc` (ignored by git: it holds the database id) from the committed
   `apps/worker/wrangler.jsonc`, with `AB_PLAN` (`--plan free|paid`, default `free`), `AB_ENVIRONMENT` (`production`
   only for the name `agility-bridge`, `test` otherwise, so non-production device tokens read `ab_test_…`) and
   `AB_PUBLIC_URL` (`--public-url`, default the deployment's `workers.dev` address, learnt from the first deploy);
3. deploys, keeping the variables you set in the Cloudflare dashboard (`keep_vars`);
4. sets the secrets that are missing: a new master key (`AB_MASTER_KEY`) and break-glass admin token
   (`AB_ADMIN_TOKEN`), passed to wrangler through stdin, never as arguments or variables. They are written to the
   `--secrets-file` (a new file, mode `0600`, created before anything is generated) and printed only with
   `--show-secrets`; without either the script refuses, because a lost master key means re-entering every token;
5. checks `GET /health` on the deployed address.

The database is migrated by the Worker at its first request. `--dry-run` shows the plan without changing anything.

Keep the secrets file like the master key of a self-hosted server: away from the data, backed up separately
([secrets](secrets.md)).

## Staging and production stay apart

Every resource is named after `--name`: `agility-bridge` is production, `agility-bridge-staging` (or any
`agility-bridge-<suffix>`) another environment with its own database, secrets and address. A local config whose worker
or database name differs from `--name` is refused, so a staging config can never be pointed at production by mistake
(THREAT_MODEL T34).

## First setup of a workspace

With the admin token from the secrets file, create the instance, credential, workspace, grant and device token
through the [admin API](../reference/admin-api.md), or with the [management commands](cli.md) pointed at the Worker:

```sh
AB_ADMIN_URL=https://agility-bridge-staging.<your-subdomain>.workers.dev \
AB_ADMIN_TOKEN_FILE=./staging.admin-token \
agility-bridge instance add "Main" https://www7.v1host.com/YourInstance
```

(`AB_ADMIN_TOKEN_FILE` holds only the token: copy the `AB_ADMIN_TOKEN=` value from the secrets file into a `0600`
file.) Then connect each device to `https://<address>/w/<slug>/mcp` with its own token ([devices](multi-device.md)).
