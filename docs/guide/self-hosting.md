# Self-hosting agility-bridge

> `agility-bridge serve` (v0.2): one server, several teams and devices, each workspace at `https://<host>/w/<slug>/mcp`.
> See also: [access model](access-model.md), [secrets](secrets.md), [CLI](cli.md), [configuration](configuration.md),
> [audit log](audit-log.md).

## Docker

The image runs `agility-bridge serve` as the non-root user `65532` on distroless Node 24, with a read-only root
filesystem and the database on the `/data` volume. It listens on port `8787` of the container (`AB_HOST=0.0.0.0` inside
the image) and has a built-in healthcheck (`GET /health`).

Until a published image exists (P2-18), build it from a checkout:

```sh
docker build -f docker/Dockerfile -t agility-bridge:local .
```

### With Docker Compose and Caddy (HTTPS)

[`docker/compose.yaml`](../../docker/compose.yaml) runs the server behind [Caddy](https://caddyserver.com), which gets and
renews the TLS certificate:

1. Set your host name in [`docker/Caddyfile`](../../docker/Caddyfile) and in `AB_PUBLIC_URL` in the compose file.
2. Create the secrets **outside** the data volume (a backup of the volume must never hold the key):

   ```sh
   cd docker && mkdir -p secrets
   agility-bridge init --key-file ./secrets/master.key
   agility-bridge admin-token > ./secrets/admin.token
   sudo chown 65532:65532 ./secrets/* && chmod 600 ./secrets/*
   ```

   The files must be readable only by their owner, uid `65532` in the container; the server refuses anything looser.
3. Start it: `docker compose up -d`, then follow the [first setup](cli.md#first-setup) with `AB_ADMIN_URL=https://<host>`
   and `AB_ADMIN_TOKEN_FILE=./secrets/admin.token`.

The compose file also drops every capability and sets `no-new-privileges`. `AB_TRUSTED_PROXY_HOPS=1` makes the rate
limits see the client address Caddy forwards; never set it when nothing sits in front of the server.

### Plain `docker run`

```sh
docker run -d --name agility-bridge --read-only --tmpfs /tmp -p 127.0.0.1:8787:8787 \
  -v agility-bridge-data:/data \
  -v "$PWD/secrets/master.key:/run/secrets/master.key:ro" -e AB_MASTER_KEY_FILE=/run/secrets/master.key \
  -e AB_PUBLIC_URL=https://mcp.example.com \
  agility-bridge:local
```

Publish the port on `127.0.0.1` and put a TLS proxy in front; the server only answers `Host` names it knows (loopback,
the host of `AB_PUBLIC_URL`, `AB_ALLOWED_HOSTS`), which blocks DNS-rebinding attacks.

### Backups

Back up the `/data` volume with the server **stopped** (a copy of a running SQLite database in WAL mode is not
consistent), and the master key **separately**: whoever has both can read every stored Agility token. A consistent
online backup command follows with the self-hosting checklist (P2-16).
