# Self-hosting agility-bridge

> `agility-bridge serve` (v0.2): one server for several teams and devices, each workspace at
> `https://<host>/w/<slug>/mcp`, next to a hosted or an on-premises Agility instance. See also:
> [access model](access-model.md), [secrets](secrets.md), [CLI](cli.md), [configuration](configuration.md),
> [audit log](audit-log.md), [devices](multi-device.md).
>
> The blocks marked for the walkthrough run in CI on a fresh machine from the package built from this repository
> (`scripts/walkthrough.ts`, L-133), so they stay correct.

## What you need

- A Linux, macOS or Windows host with **Node 24** (or Docker), reachable by your users over HTTPS through a reverse
  proxy (Caddy, nginx, Traefik, a cloud load balancer).
- An Agility instance it can reach, and an Agility access token per member (or a service member's token for shared,
  read-only access).
- A place for the **master key** that is not the data directory or its backups ([secrets](secrets.md)).

## Install (Node)

<!-- walkthrough: 1 -->
```sh
npm install -g agility-bridge
agility-bridge init
agility-bridge admin-token > ~/.config/agility-bridge/admin.token
chmod 600 ~/.config/agility-bridge/admin.token
```

`init` writes a new master key to `~/.config/agility-bridge/master.key`. `admin-token` prints the break-glass token
that turns on the admin API; keep both files readable only by the server's user.

Then create the first instance, credential, workspace, grant and device token with the
[CLI first setup](cli.md#first-setup): it works on the local database before the server ever starts.

## Run the server

<!-- walkthrough: 3 -->
```sh
AB_MASTER_KEY_FILE=~/.config/agility-bridge/master.key AB_ADMIN_TOKEN_FILE=~/.config/agility-bridge/admin.token agility-bridge serve
```

It listens on `127.0.0.1:8787` (`AB_HOST`, `AB_PORT`), stores its database in `~/.local/share/agility-bridge`
(`AB_DATA_DIR` or `AB_DB_PATH`, created `0700`/`0600`) and logs JSON lines to stderr. Check it:

<!-- walkthrough: 4 -->
```sh
curl -s http://127.0.0.1:8787/health
```

For a service, run it with your init system. A systemd unit, for example:

```ini
[Unit]
Description=agility-bridge
After=network-online.target

[Service]
User=agility-bridge
Environment=AB_MASTER_KEY_FILE=/etc/agility-bridge/master.key
Environment=AB_ADMIN_TOKEN_FILE=/etc/agility-bridge/admin.token
Environment=AB_DATA_DIR=/var/lib/agility-bridge
Environment=AB_PUBLIC_URL=https://mcp.example.com
ExecStart=/usr/bin/agility-bridge serve
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agility-bridge
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Behind a reverse proxy (HTTPS)

Terminate TLS at the proxy and forward to `127.0.0.1:8787`. Then tell the server its public address:

- `AB_PUBLIC_URL=https://mcp.example.com`: the server answers requests for that host, and sends
  `Strict-Transport-Security` on every response (also errors) because the public URL is HTTPS, even though it sees
  plain HTTP from the proxy (L-083).
- `AB_ALLOWED_HOSTS`: any other host name it should answer (comma-separated). Requests for unknown `Host` names are
  refused, which blocks DNS-rebinding attacks; so is `Origin: null`.
- `AB_ALLOWED_ORIGINS`: browser origins allowed to call it (with CORS headers). MCP clients are not browsers and need
  none.
- `AB_TRUSTED_PROXY_HOPS=1` when exactly one proxy sits in front, so rate limits see the client address from
  `X-Forwarded-For`. Never set it without a proxy: clients could then choose their own address.
- Let responses stream (no buffering): MCP answers can take up to the server's 180-second deadline.

Caddy (`reverse_proxy 127.0.0.1:8787 { flush_interval -1 }`) does all of this with automatic certificates; for nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 190s;
}
```

Then connect each device to `https://mcp.example.com/w/<slug>/mcp` with its own token ([devices](multi-device.md)). A
device token works only at its own workspace's address. Check one from the command line:

<!-- walkthrough: 5 -->
```sh
curl -s https://mcp.example.com/w/team-mobile/mcp -H "Authorization: Bearer $DEVICE_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## On-premises Agility with a private CA

The server verifies the instance's TLS certificate, always. For an instance whose certificate comes from your own CA,
give that instance the CA bundle (PEM) when you add it — it is added to the public roots for that instance only:

```sh
agility-bridge instance add "On-prem" https://agility.corp.example/Agility --ca-file /etc/agility-bridge/corp-ca.pem
```

The instance must use HTTPS (`http://` is accepted only for loopback test fixtures with `AB_ALLOW_HTTP_INSTANCES=on`).
If the server should never reach your private networks through an instance address, set
`AB_INSTANCE_PRIVATE_ADDRESSES=refuse` ([configuration](configuration.md#server-mode-agility-bridge-serve)); leave it
at `allow` when the instance itself is on a private network.

The server probes a new address without any token before using it, and validates every stored token against it
([access model](access-model.md#credential-validation)). The Cloudflare Worker deployment cannot trust private CAs;
use this server for such instances.

## Pass-through workspaces (optional)

For a simple shared server that stores **no** Agility tokens: with `AB_PASSTHROUGH=on`, an owner can make a workspace
pass-through (`agility-bridge workspace set <workspace-id> --credential-source passthrough`). Its callers send their
own Agility access token in the `X-Agility-Token` header instead of a device token, on the workspace's normal address.

- **HTTPS only**: the server refuses the header on a plain-HTTP request (behind a proxy, it trusts
  `X-Forwarded-Proto: https` only with `AB_TRUSTED_PROXY_HOPS`).
- The token is checked against the workspace's instance (the member behind it), then trusted for 5 minutes by its
  keyed fingerprint (HMAC); the token itself is never stored or logged. The audit log and the rate limits identify
  callers by that fingerprint (`pt:…`). Checking a new token costs Agility requests, so the server checks at most
  `AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE` new tokens per instance (30), shares one check between concurrent requests
  with the same token, and stops checking for a client address that has used up its failed attempts.
- Every workspace control applies unchanged: Agility projects, asset types, tools, limits, rate limits. There are no
  grants, and **never write tools** (read-only in 1.0, D-04).
- Anyone with a valid token for the instance and network access to the server can use such a workspace: keep it on a
  private network, and prefer per-user grants with device tokens when you need to know who is who.

## Docker

The image runs `agility-bridge serve` as the non-root user `65532` on distroless Node 24, with a read-only root
filesystem and the database on the `/data` volume. It listens on port `8787` of the container (`AB_HOST=0.0.0.0` inside
the image) and has a built-in healthcheck (`GET /health`). CI builds it, runs a smoke test against a synthetic Agility
and scans it on every change (`scripts/docker-smoke.ts`).

Releases from v0.2 publish it as `ghcr.io/mhidalgo-lab/agility-bridge:<version>` (also `:<major.minor>` and
`:latest`), with provenance and SBOM attestations; [verify it](verify-release.md#the-docker-image) and pin its digest.
To build it from a checkout instead:

```sh
docker build -f docker/Dockerfile -t agility-bridge:local .
```

### With Docker Compose and Caddy

[`docker/compose.yaml`](../../docker/compose.yaml) runs the published image (pinned by digest) behind
[Caddy](https://caddyserver.com), which gets and renews the TLS certificate:

1. Set your host name in [`docker/Caddyfile`](../../docker/Caddyfile) and in `AB_PUBLIC_URL` in the compose file.
2. Create the secrets **outside** the data volume (a backup of the volume must never hold the key):

   ```sh
   cd docker && mkdir -p secrets
   agility-bridge init --key-file ./secrets/master.key
   agility-bridge admin-token > ./secrets/admin.token
   sudo chown 65532:65532 ./secrets/* && chmod 600 ./secrets/*
   ```

   The files must be readable only by their owner, uid `65532` in the container; the server refuses anything looser.
3. Start it: `docker compose up -d`, then follow the [CLI first setup](cli.md#first-setup) remotely with
   `AB_ADMIN_URL=https://<host>` and `AB_ADMIN_TOKEN_FILE=./secrets/admin.token`.

The compose file also drops every capability and sets `no-new-privileges`.

### Plain `docker run`

```sh
docker run -d --name agility-bridge --read-only --tmpfs /tmp -p 127.0.0.1:8787:8787 \
  -v agility-bridge-data:/data \
  -v "$PWD/secrets/master.key:/run/secrets/master.key:ro" -e AB_MASTER_KEY_FILE=/run/secrets/master.key \
  -e AB_PUBLIC_URL=https://mcp.example.com \
  ghcr.io/mhidalgo-lab/agility-bridge:0.2.0
```

Publish the port on `127.0.0.1` and put the TLS proxy in front.

## Backups and the master key

- **Database**: `agility-bridge backup <new file>` writes a consistent copy while the server runs (mode `0600`, never
  overwriting); run it on the server host as the server's user, e.g. daily from cron. In Docker:
  `docker exec agility-bridge /nodejs/bin/node /app/dist/index.mjs backup /data/backup-$(date +%F).db`, then copy it out
  of the volume.
- **Master key**: back it up separately (a password manager, a secret store). Whoever has a backup **and** the key can
  read every stored Agility token. Without the key, a backup's tokens are lost: members enter them again.
- **Restore**: stop the server, `agility-bridge restore <backup> <new database file>` (it checks the backup and never
  overwrites), point `AB_DB_PATH` at the new file, start the server.

## Upgrades

1. `agility-bridge backup <file>` first.
2. Install the new version (`npm install -g agility-bridge@<version>`, or a new image) and restart. The server migrates
   its database on start; a database written by a **newer** version is refused, so you can roll back by restoring the
   backup with the older version.
3. Clients cache the tool list: reconnect them (or restart their MCP server) to see new tools (L-012).
4. Read the release notes for new settings; unknown `AB_` settings stop the server, so typos are caught at start.
