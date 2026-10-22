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

## Housekeeping and key rotation

A cron trigger (every 15 minutes, `wrangler.jsonc`) runs the jobs `agility-bridge serve` runs on timers, in small
slices that fit the Free plan's limits per run:

| Job | Per run | Setting |
|---|---|---|
| Audit retention | up to 3,000 rows older than the retention | `AB_AUDIT_RETENTION_DAYS` (90; `0` keeps them) |
| Expired `kv` entries | up to 1,000 | — |
| Master-key rotation | 10 credentials re-encrypted with the current key | runs while `AB_MASTER_KEY_PREVIOUS` is set and credentials remain on it |
| Credential revalidation | 1 credential, the stalest | `AB_CREDENTIAL_REVALIDATION_HOURS` (24; `0` = never) |

**Rotating the master key on Workers**: put a new key with a **higher version** (`v2:…`, 32 random bytes in base64;
a `--version` option for `agility-bridge init` is P3-13) in place with wrangler: the current value becomes
`AB_MASTER_KEY_PREVIOUS`, the new one `AB_MASTER_KEY` (`wrangler secret put … --config
apps/worker/wrangler.<name>.local.jsonc`, the value through stdin). The cron re-encrypts ten credentials per run; each
row is replaced only if it still holds what was read, so an interrupted or overlapping run is safe, and a `kv` lease
keeps two runs off the same batch. Progress shows in the Worker's log (`key rotation continues` with the remaining
count). Keep `AB_MASTER_KEY_PREVIOUS` set until the rotation is done; checking the remaining count and retiring the old
version through the admin API arrive with P3-13 ([secrets](secrets.md)).

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
