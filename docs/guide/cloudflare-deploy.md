# Deploy to Cloudflare Workers

> Deployment mode D: agility-bridge as a Cloudflare Worker on D1, reachable from every device, no server to run.
> Limits, measured costs and rate limits per plan: [Cloudflare limits](cloudflare-limits.md). Executed against a real
> account as recorded in [verification](../dev/verification.md#cloudflare-deployment-p3-05-p3-07).

## Which Agility instances a Worker can reach

- **Hosted Agility** (`*.v1host.com`) and any instance reachable **from the internet with a publicly trusted
  certificate**: yes.
- **On-premises** Agility on a private network, or with a certificate from a private CA: Workers cannot trust a private
  CA and cannot reach private networks. Either publish the instance through a
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with a public
  hostname (it then has a publicly trusted certificate, and you decide who may reach it), or run
  [`agility-bridge serve`](self-hosting.md) next to it ([ADR-0014](../adr/0014-supported-agility-installations.md)).

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

## Move a self-hosted deployment to the Worker

Moves everything a self-hosted `agility-bridge serve` holds — users, instances, credentials (still encrypted),
workspaces, grants, device tokens, settings, audit — so nobody re-enters an Agility token and existing device tokens
keep working at the new address. One-way, into an **empty** deployment (L-078):

1. Make a backup on the server: `agility-bridge backup ./agility-bridge-backup.db` (the live database is never read).
2. Create the Worker with `pnpm cf:setup --name <worker> …` and give it the **server's master key**: with wrangler,
   put the content of the server's key file into `AB_MASTER_KEY` (stdin), replacing the generated one. To move to a
   new key at the same time, set the new key as `AB_MASTER_KEY` and the server's as `AB_MASTER_KEY_PREVIOUS`; the
   cron then re-encrypts every credential ([housekeeping](#housekeeping-and-key-rotation)).
3. Open `https://<address>/health` once (the Worker migrates its empty database and records the key).
4. Copy the backup in:

   ```sh
   pnpm cf:migrate --name <worker> --from ./agility-bridge-backup.db
   ```

   It refuses, before writing anything, a target that already has users, instances, credentials, workspaces,
   grants, device tokens or settings (audit rows of refused requests are fine: they stay), a different schema version (upgrade the server and
   the Worker to the same release first), or a Worker without the server's master key. It writes the rows as SQL
   (`0600`, deleted afterwards; it holds ciphertext and token hashes), imports it with `wrangler d1 execute --remote`,
   and checks the row counts. Rate-limit counters and other transient state are not copied.
5. Point the devices at `https://<address>/w/<slug>/mcp` (their tokens are unchanged), then stop the old server and
   delete the backup.

## A custom domain

```sh
pnpm cf:setup --name agility-bridge --domain mcp.example.com --secrets-file ~/.config/agility-bridge/prod.secrets
```

The domain must be a zone in the same Cloudflare account. `--domain` adds a Workers custom domain (Cloudflare creates
the DNS record and the certificate), makes `https://mcp.example.com` the public URL (`AB_PUBLIC_URL`) and turns the
`workers.dev` address off, so the Worker has one address and refuses every other `Host` (T24). Clients then use
`https://mcp.example.com/w/<slug>/mcp`.

**Bot protection must not challenge MCP clients** (L-028). On the zone, *Bot Fight Mode*, *Browser Integrity Check*
and challenge rules answer non-browser clients with a challenge page, `403` or error `1010`, and MCP clients cannot
pass them. Add a WAF custom rule *Skip* for `http.request.uri.path wildcard "/w/*/mcp"` (and `/api/admin/*` if you
use the admin API remotely) that skips Browser Integrity Check and the managed bot rules, or turn Bot Fight Mode off
for the zone. Leave the Worker's own limits in place: they apply after the skip.

## Costs

| | Free | Workers Paid (from 5 USD a month) |
|---|---|---|
| Requests | 100,000 a day | 10 million a month included |
| CPU per request | 10 ms ([measured](cloudflare-limits.md#measured-cost): warm calls fit, a new isolate's first request does not yet, P3-14) | 30 s default |
| Agility requests per tool call | 45 (preset and ceiling) | 1,000 |
| D1 | 5 million rows read and 100,000 written a day | 25 billion read and 50 million written a month included |
| Scheduled housekeeping | every 15 minutes, in small slices | same |

Every MCP request reads a few D1 rows (access resolution is one batch, the access cache saves most of it) and writes an
audit row per tool call, so the Free plan's 100,000 written rows a day are the first limit for a busy team. Prices
and allowances: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (checked 2026-10).

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
